## Section 6: CPU Frequency Scaling and Thermal Throttling

### 6.1 Thermal Detection

CPU thermal throttling occurs when the processor temperature reaches its thermal junction limit and the hardware drops the clock to shed heat. It manifests as latency spikes that are hard to distinguish from software bottlenecks, which is exactly why it is worth being able to detect directly.

Before writing any code, get one distinction right, because nearly every homegrown throttle monitor gets it wrong: **a CPU running below its maximum frequency is not throttling.** Modern CPUs advertise a turbo maximum they can only sustain briefly on a couple of cores. Running below it is the normal, healthy, designed state. The machine these examples were verified on, an Intel i7-10510U, reports:

```
scaling_cur_freq   3298807 kHz   (3.3 GHz, current)
cpuinfo_max_freq   4900000 kHz   (4.9 GHz, single-core turbo ceiling)
base_frequency      800000 kHz   (0.8 GHz)
x86_pkg_temp            54 °C    (cool, unstressed)
```

A monitor that flags "throttling" whenever current frequency falls below 80 percent of `cpuinfo_max_freq` reports throttling on this machine, right now, at 54 °C and nearly idle, because 3.3/4.9 is 0.67. That alert is pure noise, and an alert that fires while nothing is wrong trains everyone to ignore it.

The frequency ratio is a guess. Do not guess, because the kernel already counts the real thing. Intel exposes hardware throttle event counters at `/sys/devices/system/cpu/cpu*/thermal_throttle/`, and a *rising* `package_throttle_count` is throttling, definitionally, with no threshold to tune. The monitor below reads those counters and treats frequency and temperature as context to report alongside the event, not as the detector.

```go
package thermal

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ThermalMonitor reports hardware thermal throttling events on Linux/x86.
// It is deliberately built around the kernel's throttle event counters rather
// than around a frequency threshold. See ThermalStatus.Throttling.
type ThermalMonitor struct {
	tempPath     string // Discovered CPU package sensor, "" if none found.
	interval     time.Duration
	handler      func(ThermalStatus)
	stop         chan struct{}
	lastThrottle uint64
	haveLast     bool
}

// ThermalStatus captures the current thermal state.
type ThermalStatus struct {
	TempCelsius float64
	FreqMHz     int
	MaxFreqMHz  int // Turbo ceiling. The CPU is NOT expected to sit here.

	// ThrottleCount is the cumulative count of hardware thermal throttle events
	// since boot. Only its delta is meaningful: a large absolute value just
	// means the machine has been up a while.
	ThrottleCount uint64

	// Throttling is true when ThrottleCount increased since the previous poll,
	// meaning the hardware actually throttled during that window. It is NOT
	// derived from FreqMHz/MaxFreqMHz, because a CPU below its turbo ceiling is
	// simply a CPU doing its job.
	Throttling bool
}

// findPackageSensor locates the CPU package temperature zone by its type, since
// the zone numbering is not stable across machines and most zones are not the
// CPU. On the verification machine, thermal_zone0 is "acpitz" (chassis) and
// thermal_zone1 is "INT3400 Thermal" (an ACPI control device that reports a
// constant 20C). Hardcoding zone0 and zone1, as is common, monitors neither
// the CPU nor anything else useful.
func findPackageSensor() string {
	zones, _ := filepath.Glob("/sys/class/thermal/thermal_zone*")
	for _, zone := range zones {
		typ, err := os.ReadFile(filepath.Join(zone, "type"))
		if err != nil {
			continue
		}
		switch strings.TrimSpace(string(typ)) {
		case "x86_pkg_temp", "coretemp", "cpu-thermal", "soc_thermal":
			return filepath.Join(zone, "temp")
		}
	}
	return ""
}

func NewThermalMonitor(interval time.Duration, handler func(ThermalStatus)) *ThermalMonitor {
	return &ThermalMonitor{
		tempPath: findPackageSensor(),
		interval: interval,
		handler:  handler,
		stop:     make(chan struct{}),
	}
}

func (m *ThermalMonitor) Start() {
	go func() {
		ticker := time.NewTicker(m.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if status := m.readStatus(); status.Throttling {
					m.handler(status)
				}
			case <-m.stop:
				return
			}
		}
	}()
}

// Stop is safe to call once. Calling it twice closes a closed channel and
// panics, which is worth stating rather than leaving for a reader to discover.
func (m *ThermalMonitor) Stop() { close(m.stop) }

// readIntFile reads a sysfs file containing a single integer.
func readIntFile(path string) (int, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0, false
	}
	return n, true
}

// readStatus is called only from the monitor goroutine, so the lastThrottle
// bookkeeping below needs no lock.
func (m *ThermalMonitor) readStatus() ThermalStatus {
	var status ThermalStatus

	if m.tempPath != "" {
		if milliC, ok := readIntFile(m.tempPath); ok {
			status.TempCelsius = float64(milliC) / 1000.0
		}
	}
	if khz, ok := readIntFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"); ok {
		status.FreqMHz = khz / 1000
	}
	if khz, ok := readIntFile("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"); ok {
		status.MaxFreqMHz = khz / 1000
	}

	// The actual detector. package_throttle_count increments when the package
	// hits its thermal limit. Intel-specific: on AMD and ARM this path does not
	// exist, and Throttling stays false rather than being faked from frequency.
	count, ok := readIntFile(
		"/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count")
	if !ok {
		return status
	}
	status.ThrottleCount = uint64(count)

	// The first poll establishes a baseline. Without this guard, a monitor
	// started on a machine that throttled hours ago reports throttling now.
	if m.haveLast {
		status.Throttling = status.ThrottleCount > m.lastThrottle
	}
	m.lastThrottle = status.ThrottleCount
	m.haveLast = true

	return status
}

func (s ThermalStatus) String() string {
	throttleStr := "no"
	if s.Throttling {
		throttleStr = "YES"
	}
	return fmt.Sprintf("Temp=%.1f°C Freq=%d/%dMHz(turbo) ThrottleEvents=%d Throttling=%s",
		s.TempCelsius, s.FreqMHz, s.MaxFreqMHz, s.ThrottleCount, throttleStr)
}
```

### 6.2 The public-cloud reality check

Most Go services today run in public cloud, where CPU frequency scaling and thermal throttling look different from bare metal. AWS, GCP, and Azure hypervisors expose a nominal CPU frequency that is generally what you get, modulo a few realities. First, burstable instance types (AWS `t3`/`t4g`, GCP `e2`) actively throttle when CPU credits deplete, and the throttling looks identical to thermal throttling from inside the guest. Second, cloud hosts oversubscribe CPUs on smaller instance types, and a noisy neighbor on the same physical core (hyperthread sibling) can take away measurable throughput without showing up in your guest metrics. Third, steal time (`st` column in `top`, `node_cpu_seconds_total{mode="steal"}` in Prometheus) reveals hypervisor-imposed contention and is often the real signal to watch. Before spending time on thermal monitoring in a cloud-hosted service, confirm that steal time is zero and that you are not on a burstable instance. When a cloud-hosted service reports "the CPU got slow," steal time and credit depletion are the overwhelmingly likelier causes, and thermal throttling is not something you can act on anyway when you do not own the hardware. Check the two you can act on first. Note also that the throttle counters the monitor above reads are frequently absent or meaningless inside a VM, so on cloud instances that code will simply report `Throttling=false` forever. That is the correct answer to the wrong question.

### 6.3 Junior → FAANG: the hardware variability awareness

Public cloud and bare metal behave differently, and knowing this distinction shows up in system design interviews. On bare metal, thermal throttling is a real concern for services that run at sustained 80 percent CPU or higher. On cloud VMs, the hypervisor provides a stable frequency but introduces steal time and neighbor effects. On Apple Silicon laptops and M-series Mac Minis (which some teams use for CI), performance cores and efficiency cores have different clock speeds and Go's scheduler does not distinguish them, so benchmarks on an M-series box can be misleadingly optimistic. Know these three environments and you will not be fooled by a benchmark result from one that does not transfer to another. When you inherit a service or benchmark, ask "what hardware generated this number, and is it the same hardware we will run on."

### 6.4 Senior @ FAANG: when frequency monitoring is worth the cost

Most services do not need thermal monitoring. The signal-to-noise ratio is low, the dashboard real estate is expensive, and the action on a throttling event is usually the same as the action on any latency spike (capacity headroom, workload shifting, hardware replacement). The staff-engineer bar for adopting throttle monitoring is: the service runs on bare metal that you control, the service is CPU-bound with sustained high utilization, the service has experienced an incident that was root-caused to throttling, and the service has SLO-critical latency. That is an "and", not an "or". Outside those cases, spend the dashboard slot on something else. If you do add it, alert on a rising throttle-event counter, never on a frequency threshold, for the reason demonstrated in 6.1: the frequency threshold fires on healthy machines and teaches the team to ignore the alert. When you do add it, wire the alerts to the hardware team, not the on-call. Throttling is almost always a hardware remediation (fan, heatsink, airflow, replacement), not a software incident.

---
