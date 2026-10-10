## AUTOSAR Classic vs Adaptive

AUTOSAR (AUTomotive Open System ARchitecture) is the standard software architecture for automotive ECUs. It is the framework that BMW, Mercedes, Volkswagen, Stellantis, and most of the Tier 1 suppliers (Bosch, Continental, Vector, ZF, Aptiv) use to build the firmware in every modern car. There are two flavors. AUTOSAR Classic targets microcontrollers with no operating system in the desktop sense. AUTOSAR Adaptive targets application processors running POSIX-class operating systems and is the framework for software-defined vehicles.

### AUTOSAR Classic

AUTOSAR Classic was first released in 2003. It targets Cortex-M, Power Architecture (NXP MPC57xx, ST SPC58xx), Tricore (Infineon Aurix), and Renesas RH850. It assumes a microcontroller with internal flash, no MMU, no dynamic memory after init, and a real-time scheduler.

The architecture is layered. From bottom to top:

1. **Microcontroller Abstraction Layer (MCAL)**: drivers for ADC, PWM, CAN, LIN, FlexRay, GPT, MCU clocks
2. **ECU Abstraction Layer**: hardware-independent driver wrappers
3. **Services Layer**: communication stacks (CAN, LIN, Ethernet), diagnostics (UDS), NVRAM manager, watchdog manager
4. **Runtime Environment (RTE)**: code generated from configuration, the glue between application components
5. **Application Layer**: software components (SWCs) that contain the business logic

A software component looks like a class with ports. Ports are inter-component interfaces, either sender-receiver (data flow) or client-server (RPC). The RTE generator produces the code that connects ports between components and routes them to the underlying communication stack.

```c
// Generated RTE function prototypes
extern Std_ReturnType Rte_Read_BrakePedal_Position(uint8* value);
extern Std_ReturnType Rte_Write_BrakeDemand_Force(uint16 value);

// Application code
void BrakeController_Run() {
    uint8 pedal;
    if (Rte_Read_BrakePedal_Position(&pedal) == E_OK) {
        uint16 force = compute_brake_force(pedal);
        Rte_Write_BrakeDemand_Force(force);
    }
}
```

The language is C in most Classic shops. C++ is allowed by the standard but rarely used because the toolchain support and the static analyzers were built around C. The latest Classic releases (R22-11, R23-11) added more support for C++14, but the gravity in Classic is still C.

The communication backbone is CAN and CAN-FD, with LIN for body electronics, FlexRay for legacy chassis applications, and Automotive Ethernet (100BASE-T1, 1000BASE-T1) bridging from Classic ECUs to Adaptive zone controllers.

### AUTOSAR Adaptive

AUTOSAR Adaptive was released in 2017 to address a gap. Modern vehicles have central compute units running ADAS perception, infotainment, cockpit, and over-the-air update. These workloads need POSIX, virtual memory, gigabytes of RAM, and an upgrade path to incrementally deployable services. Classic was not designed for any of that.

Adaptive targets POSIX-compliant operating systems: typically QNX, PikeOS, Linux with PREEMPT_RT, or VxWorks. The application processors are Cortex-A class: Cortex-A72, A76, A78AE, plus the upcoming Cortex-X series in the Snapdragon Ride flex platform from Qualcomm.

**The language is C++. C++14 minimum, with the current AUTOSAR Adaptive release (R23-11, late 2023) supporting C++14 and most of C++17.** Vector's MICROSAR Adaptive, Elektrobit's EB corbos, Continental's CRTV, and Bosch's reference implementations all use C++ throughout.

The Adaptive architecture is service-oriented. Components are services that communicate over Service-Oriented Communication (SOME/IP) or DDS (Data Distribution Service) over Ethernet. There is a dedicated set of "AUTOSAR Adaptive Foundation" libraries (`ara::core`, `ara::com`, `ara::log`, `ara::diag`, `ara::exec`) that wrap POSIX and provide the AUTOSAR-mandated APIs.

```cpp
#include "ara/core/future.h"
#include "ara/com/runtime.h"
#include "perception/skeleton.h"

class PerceptionService : public perception::skeleton::PerceptionSkeleton {
public:
    PerceptionService(ara::com::InstanceIdentifier id)
        : PerceptionSkeleton(id) {}

    ara::core::Future<ObjectList> GetObjects() override {
        ObjectList objects = current_objects();
        ara::core::Promise<ObjectList> p;
        p.set_value(std::move(objects));
        return p.get_future();
    }
};

int main() {
    ara::com::Runtime::Initialize();
    PerceptionService svc(ara::com::InstanceIdentifier::Any);
    svc.OfferService();
    ara::core::Pause();
}
```

The runtime, the skeletons (server side), and the proxies (client side) are generated from ARXML files (AUTOSAR XML), the same configuration format that Classic uses for SWCs. The shape of the generated C++ is similar to gRPC or thrift-generated stubs, but with AUTOSAR-specific semantics for service discovery, restartability, and health monitoring.

### Vector Tooling

Vector Informatik is the dominant tool vendor for AUTOSAR. The toolchain includes:

- **DaVinci Configurator Pro**: configure the Classic BSW (basic software) and generate the RTE
- **DaVinci Developer**: model SWCs and their ports
- **DaVinci Adaptive**: configure Adaptive applications and generate skeletons/proxies
- **CANoe**: simulate ECUs for testing
- **CANalyzer**: passive bus monitoring and diagnostics
- **vTESTstudio**: scripted ECU testing

Anyone working in automotive C++ at BMW, Mercedes, or VW has Vector tools open all day. The licenses are expensive (tens of thousands of euros per seat) but the productivity is real.

The competing tools are Elektrobit (EB tresos for Classic, EB corbos for Adaptive), ETAS RTA (Bosch subsidiary), KPIT, and Mentor (Siemens) Volcano.

### ASIL Ratings in AUTOSAR

ASIL (Automotive Safety Integrity Level) classifies safety-critical functions. The four levels:

- **ASIL A**: lowest. Examples: instrument cluster lighting, audio volume.
- **ASIL B**: examples: rear lights, headlights, fuel level display.
- **ASIL C**: examples: cruise control, electric power steering with mechanical fallback.
- **ASIL D**: highest. Examples: brake-by-wire, electric power steering without fallback, airbag deployment, battery management for high-voltage packs.

A function inherits the highest ASIL of any safety goal it contributes to. An ECU may run components at multiple ASILs in different partitions, with hardware (MMU, MPU) or software (hypervisor) isolation between them.

AUTOSAR Classic and Adaptive both have provisions for ASIL D, including the use of dual ECUs in lockstep, plausibility checks at the application level, watchdog cascades, and end-to-end (E2E) protection of safety-critical messages with sequence counters and CRCs.

The mixed criticality is the hard part. An infotainment service (QM, no ASIL) must not interfere with an ASIL B parking assistant on the same SoC. The standard pattern is to run the ASIL B partition under a real-time hypervisor (Sasken Sasken-Hyp, BlackBerry QNX Hypervisor, OpenSynergy COQOS) with hardware-isolated cores and memory. The QM partition cannot affect the ASIL partition's CPU time, memory, or interrupts.

### Software-Defined Vehicle

The "software-defined vehicle" (SDV) is the industry's current direction. Instead of dozens of fixed-function ECUs (one for windows, one for seat heaters, one for tailgate), the architecture consolidates around a few high-performance compute (HPC) units running Adaptive plus zone controllers running Classic.

A modern Mercedes EQS or BMW iX has a layout roughly like:

- 1 HPC for ADAS (NVIDIA Orin or Qualcomm Ride): runs perception, planning, sensor fusion in C++ on Cortex-A78AE
- 1 HPC for cockpit/infotainment (Qualcomm 8295): runs Android Automotive, instrument cluster, navigation
- 1 HPC for vehicle dynamics: runs vehicle motion control with ASIL D path on a Cortex-R lockstep partition
- 4 to 8 zone controllers (Aurix TC4x or Renesas RH850): connect local sensors and actuators, run AUTOSAR Classic

Adaptive runs the HPCs. Classic runs the zone controllers. Both connect over 100/1000BASE-T1 Automotive Ethernet with TSN (Time-Sensitive Networking) for deterministic delivery of safety messages.

C++ is the language of the HPC side. The Adaptive C++ subset is a superset of MISRA C++ 2008 with AUTOSAR-specific additions. AUTOSAR C++14 (the coding standard) was released in 2017 and was the dominant subset until MISRA C++ 2023 superseded it by reunifying the AUTOSAR rules back into MISRA. Most active programs in 2026 are migrating from AUTOSAR C++14 to MISRA C++ 2023.

### Practical Take

If you are interviewing for an embedded C++ role at BMW, Mercedes, Audi, Stellantis, Bosch, Continental, or Vector, expect questions on:

- The difference between Classic and Adaptive
- Why AUTOSAR Adaptive uses C++ and Classic uses C
- ASIL levels with examples
- E2E protection mechanisms (sequence counters, CRCs, alive counters)
- The role of an RTE in Classic and what replaces it in Adaptive (`ara::com`)
- Service-oriented communication: SOME/IP versus DDS
- Mixed-criticality ECUs and hypervisors
- Why the language standard is C++14 minimum and not the latest C++
- How over-the-air update works on a vehicle (signed images, A/B partitions, rollback protection)

The single most important sentence to internalize: AUTOSAR is not a library, it is a contract. The standard tells you what services exist and what their interfaces are. The implementation comes from Vector, Elektrobit, or in-house. Your C++ code calls the contract.

---
