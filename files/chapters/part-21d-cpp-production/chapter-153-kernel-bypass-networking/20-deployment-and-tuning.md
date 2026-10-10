## Deployment and Tuning: BIOS, Kernel, NIC, Network

Software-only kernel bypass leaves performance on the table. The same DPDK or ef_vi binary can produce 600 ns p99 on a tuned host and 4000 ns p99 on a stock host. The difference is in BIOS, kernel command line, NIC ring sizes, network design, and the hundred small switches the OS provides. This chapter is the production checklist.

### BIOS / UEFI Settings

These are the settings that matter on Intel and AMD server platforms. Names vary by vendor, the semantics are the same.

| Setting | Value | Reason |
|---|---|---|
| Hyperthreading / SMT | Disable (HFT) or Enable (CDN) | HFT cannot tolerate HT noise. CDN benefits from extra logical CPUs |
| Turbo Boost | Enable, fixed turbo ratio | Boost frequency on active cores |
| C-states | Disable C3, C6 (HFT) or default (CDN) | C-state exit latency is jitter |
| P-states | Performance | Eliminates frequency scaling decisions |
| NUMA | Enable, no node interleaving | Need NUMA visibility for pinning |
| Snoop Mode | COD or hemi (HFT), home/early (CDN) | LLC slice access patterns |
| Energy Performance Bias | Performance | Prevents kernel from idling cores |
| Memory frequency | Max supported | DDR5 throughput matters |
| PCIe ASPM | Disable | ASPM exit latency adds jitter |
| SR-IOV | Enable if used | Virtual functions for VM pass-through |
| Intel SpeedStep | Disable (HFT) or Enable (CDN) | Same C-state argument |

For Dell, HP, Supermicro, Lenovo, and Quanta servers, the manufacturer publishes a "low latency BIOS profile" that toggles most of these. Use it as a starting point, then verify each setting in the BIOS by hand.

### Kernel Command Line

The full HFT command line in `/etc/default/grub`:

```
GRUB_CMDLINE_LINUX="
isolcpus=2-7,10-15
nohz_full=2-7,10-15
rcu_nocbs=2-7,10-15
intel_idle.max_cstate=0
processor.max_cstate=1
idle=poll
intel_pstate=performance
mce=ignore_ce
audit=0
selinux=0
tsc=reliable
clocksource=tsc
nosoftlockup
nowatchdog
nmi_watchdog=0
mitigations=off
transparent_hugepage=never
default_hugepagesz=1G
hugepagesz=1G
hugepages=8
hugepagesz=2M
hugepages=2048
iommu=pt
intel_iommu=on
"
```

Notes per option:

- `mitigations=off` disables Spectre/Meltdown mitigations. Acceptable on a dedicated trusted host, never on multi-tenant. Restores 200-500 ns to syscall paths and 5-10% to integer benchmarks.
- `iommu=pt intel_iommu=on` keeps IOMMU on (necessary for DPDK with vfio-pci) but in passthrough mode for the host kernel itself.
- `nowatchdog nmi_watchdog=0` disables watchdog hrtimers that fire periodically across all CPUs.

### Tuned Profiles

`tuned` ships profile collections. Useful starting points:

```bash
sudo tuned-adm profile network-latency
# or for HFT
sudo tuned-adm profile cpu-partitioning
# Edit /etc/tuned/cpu-partitioning-variables.conf:
# isolated_cores=2-7,10-15
sudo tuned-adm profile cpu-partitioning
```

`network-latency` disables busy-poll throttling and tunes networking sysctls. `cpu-partitioning` does the isolcpus/nohz/rcu work via tuned rather than command-line. Either is fine, pick one.

### Network Sysctls

For kernel-stack paths that coexist with bypass:

```bash
# /etc/sysctl.d/99-low-latency.conf
net.core.busy_poll = 50
net.core.busy_read = 50
net.core.netdev_max_backlog = 250000
net.core.somaxconn = 65535
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.ipv4.tcp_low_latency = 1
net.ipv4.tcp_no_metrics_save = 1
net.ipv4.tcp_timestamps = 0     # save 12 bytes per segment
net.ipv4.tcp_sack = 1
net.ipv4.tcp_congestion_control = bbr
```

`tcp_timestamps=0` is debated, some HFT firms disable it for the small wire saving, others keep it for accurate RTT estimation. Default for non-HFT: keep on.

### NIC Ring Sizes and Coalescing

```bash
# Ring depths
sudo ethtool -G eth0 rx 4096 tx 4096

# Interrupt coalescing: 0 = disabled (best for kernel-stack low-latency)
sudo ethtool -C eth0 rx-usecs 0 tx-usecs 0 \
                     rx-frames 1 tx-frames 1 \
                     adaptive-rx off adaptive-tx off

# RX/TX hashing
sudo ethtool -X eth0 hkey 6d:5a:6d:5a:...   # symmetric Toeplitz (chapter 04)
sudo ethtool -K eth0 ntuple on              # enable n-tuple steering
sudo ethtool -K eth0 lro off                # disable LRO; harms latency
sudo ethtool -K eth0 gro off                # disable GRO; same
sudo ethtool -K eth0 tso on                 # TX segmentation offload
sudo ethtool -K eth0 rxvlan off txvlan off  # if not using VLAN

# IRQ affinity per RX queue
for q in $(seq 0 15); do
    irq=$(grep "${eth0}-${q}" /proc/interrupts | awk '{print $1}' | tr -d :)
    cpu=$((q % 2))
    echo $cpu | sudo tee /proc/irq/$irq/smp_affinity_list
done
```

For DPDK ports, ring sizes are configured in software (`rte_eth_rx_queue_setup`, chapter 03), but the firmware-level settings on the NIC still matter (max ring depth, max queues). Confirm with `dpdk-testpmd --rxd=8192 --txd=8192` at startup.

### Disable Power-Saving Surprises

```bash
# Lock CPU frequency to max
sudo cpupower frequency-set -g performance
sudo cpupower frequency-set -d 4.5GHz

# Disable cpufreq for isolated cores entirely (uses intel_pstate "performance" governor + per-cpu locking)
for c in 2 3 4 5 6 7 10 11 12 13 14 15; do
    echo performance | sudo tee /sys/devices/system/cpu/cpu$c/cpufreq/scaling_governor
done

# Disable kernel SMP affinity rebalancing
sudo systemctl disable --now irqbalance

# Disable all unneeded services
sudo systemctl disable --now snapd cron tuned bluetooth ModemManager
```

### ECMP and Flow Steering at the Network Level

For multi-host throughput, the switch fabric must distribute flows. Configure ECMP (Equal-Cost Multi-Path) on the spine and leaf switches. The hash function on the switch matters: 5-tuple symmetric Toeplitz is the standard.

For HFT, the switch is dedicated, the fabric is small, and ECMP is unused. The path from NIC to colocated exchange port goes through the Cisco Nexus 3550 (or equivalent) with a static rule.

For CDN, ECMP across L3 spine plus consistent-hash mapping at the load balancer (Maglev-style) is the standard. AnyIP and BGP-anycast for client-facing addresses.

### Validation Checklist

After applying all the above, validate with:

```bash
# 1. Confirm isolated cores are actually idle
top -d1 -p $(pgrep my_app)
mpstat -P ALL 1 5

# 2. TSC jitter test from chapter 11 - expect <100 ns max delta over 1 hour

# 3. NIC counters under load
sudo ethtool -S eth0 | grep -E 'drop|miss|error|out_of_buffer'
# Should be zero or near-zero

# 4. PTP convergence
sudo pmc -u -b 0 'GET CURRENT_DATA_SET'
# offsetFromMaster should be <100ns

# 5. Hugepage availability
grep Huge /proc/meminfo

# 6. IOMMU mode
dmesg | grep -i 'iommu\|dmar'

# 7. C-state status
cat /sys/devices/system/cpu/cpu2/cpuidle/state*/disable
# All should be 1 (disabled) for the busy-poll cores
```

### Continuous Verification

The configuration must stay correct after reboots, kernel upgrades, NIC firmware updates, and OS package updates. Build a config-drift detector:

```bash
#!/bin/bash
expected=(
    "isolcpus=2-7,10-15"
    "nohz_full=2-7,10-15"
    "rcu_nocbs=2-7,10-15"
    "default_hugepagesz=1G"
)
for e in "${expected[@]}"; do
    if ! grep -q "$e" /proc/cmdline; then
        echo "DRIFT: $e missing from kernel command line"
        exit 1
    fi
done
```

Run from cron every 10 minutes, alert on failures. A real production environment also locks down BIOS settings via Redfish API and verifies those after reboot.

### Hardware Choices

Beyond settings, hardware choice matters:

- **CPU.** AMD EPYC Genoa/Bergamo and Intel Sapphire/Emerald/Granite Rapids are current HFT picks. Higher single-thread frequency wins for hot loops.
- **NIC.** Solarflare X3522 / X2522 for HFT, Mellanox CX-7 / BlueField-3 for CDN and cloud.
- **Switch.** Cisco Nexus 3550 for trading-floor cabinets. Mellanox Spectrum-3 / SN5000-series for datacenter spine. Arista 7060 / 7280 for cloud / CDN.
- **Memory.** DDR5-5600 or higher for new builds. Channel count matters more than frequency.

> Junior engineer behavior: declaring a benchmark "production-grade" without verifying BIOS, kernel, or NIC settings.
> Senior FAANG move: a documented configuration baseline (BIOS + kernel + tuned + sysctl + ethtool + IRQ + cpuset), automated drift detection, and a published validation script that any reviewer can run to confirm the host is in spec.
