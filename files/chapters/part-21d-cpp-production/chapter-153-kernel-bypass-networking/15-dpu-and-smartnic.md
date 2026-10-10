## DPUs and SmartNICs: BlueField, Nitro, IPU, P4

The DPU (Data Processing Unit) is the third leg of modern datacenter compute, alongside the CPU and the GPU. A DPU is a NIC plus a self-contained ARM-based Linux server welded together on one PCIe card. It runs its own OS, has its own memory, and processes packets locally before they reach (or after they leave) the host. This shifts work that used to run on the host CPU (vSwitch, firewall, encryption, telemetry, NVMe-over-Fabric) onto a card that can be programmed independently.

For C++ engineers building network fast paths, the DPU is both a deployment target (you write code that runs on its ARM cores) and a service provider (you write host code that talks to a DPU running someone else's logic). This chapter covers the major DPU families, their programming models, and where C++ fits.

### The Major DPU Families

- **Nvidia BlueField-3.** 16x ARM Cortex-A78AE cores, 32 GB DDR5, dual 400 Gbit Ethernet ports, ConnectX-7 packet processor on the same SoC. Programming model: DOCA SDK (DPU Open Compute Acceleration), which exposes most of the existing Mellanox accelerators (rte_flow, rdma-core, OVS) plus DPU-specific primitives (DOCA Flow, DOCA RegEx, DOCA SHA). The DPU runs Ubuntu (DOCA OS) by default. AWS-style "host-isolated" mode is available where the host kernel cannot see the NIC at all, only the DPU sees it.
- **AWS Nitro.** Amazon's internal DPU, used in every EC2 instance since C5/M5. Not user-programmable. Provides the EBS, ENA, and instance security boundary. Visible only via the EC2 hypervisor surface. Worth understanding because it is the model that proved DPUs scale, not a programming target outside Amazon.
- **Intel IPU E2100 (Mt. Evans).** 16x ARM Neoverse N1 cores, P4-programmable packet pipeline (Tofino-derived), 200 Gbit Ethernet. Programming model: P4 for the dataplane, IPDK (Infrastructure Programmer Development Kit) for the slow path. Used by Google internally, available in some enterprise channels.
- **Marvell OCTEON 10.** Family of NPU/DPUs with 24-36 ARM cores, hardware TLS, 5G/networking accelerators. Dominant in carrier infrastructure.
- **Pensando DSC2 (now AMD/Cisco).** 16x ARM cores, P4 pipeline. Used in Cisco UCS and AMD's "Salina" line.

### Why DPUs Exist

The economic argument is simple. A 200 Gbit Ethernet link, fully used with VXLAN encap, ESP encryption, and connection tracking, eats ~6 host CPU cores at sustained line rate. A 400 Gbit link eats 12. On a 64-core host, that is 9-19% of the host's compute permanently allocated to networking overhead. Move it to a DPU's ARM cores, designed for exactly this load, and the host CPUs are returned to revenue-generating workloads.

The security argument is also strong: the DPU is a trust boundary. The host can be compromised, if the firewall and the encryption keys live on the DPU, the attacker has not breached them. AWS Nitro is the canonical example. Tenant code on the host has no privileged path to the network or to EBS.

### DOCA: Programming a BlueField

DOCA exposes a layered model. Most C++ engineers will start at the DOCA Flow level, which is essentially "rte_flow with extensions for DPU-specific match and action types."

```cpp
#include <doca_flow.h>

doca_flow_cfg cfg{};
cfg.queues = 1;
cfg.mode_args = "switch,hws";   // hardware-steering on switching ASIC
doca_flow_init(&cfg);

doca_flow_port_cfg pcfg{};
pcfg.port_id = 0;
doca_flow_port* port;
doca_flow_port_start(&pcfg, &port);

// Build a pipeline: match VXLAN VNI 100 -> decap, forward to host
doca_flow_match match{};
match.tun.type = DOCA_FLOW_TUN_VXLAN;
match.tun.vxlan_tun_id = htonl(100 << 8);

doca_flow_actions actions{};
actions.decap = true;
actions.has_encap = false;

doca_flow_fwd fwd{};
fwd.type = DOCA_FLOW_FWD_PORT;
fwd.port_id = 1;   // host-facing port

doca_flow_pipe_cfg pipe_cfg{};
pipe_cfg.attr.name = "vxlan_decap";
pipe_cfg.attr.type = DOCA_FLOW_PIPE_BASIC;
pipe_cfg.match = &match;
pipe_cfg.actions = &actions;
pipe_cfg.port = port;

doca_flow_pipe* pipe;
doca_flow_pipe_create(&pipe_cfg, &fwd, nullptr, &pipe);
doca_flow_pipe_add_entry(/*queue=*/0, pipe, &match, &actions, nullptr,
                         &fwd, /*flags=*/0, nullptr, nullptr);
```

This installs a hardware rule that strips VXLAN, no software hop. Throughput: line rate, 400 Gbit, no host CPU.

### eBPF on the SmartNIC

The other programming model is "the same XDP/eBPF you wrote for the host runs on the NIC." Netronome (Agilio) and Marvell support this, recent BlueField FW also supports BPF offload paths via DOCA. The model is identical to chapter 05 except the program runs in the NIC's processor cluster.

A typical use: an L4 firewall written as an eBPF program. Compile once, load on the host driver, and let the NIC offload it. If the NIC firmware supports the program's instructions, packets are filtered without reaching the host. If not, fall back to host-XDP.

### P4 Pipelines

P4 is a domain-specific language for packet processing. Originally for switch ASICs (Tofino), now also for DPUs (Intel IPU, AMD Pensando). A P4 program describes match-action tables, parser graphs, deparser sequences. The P4 compiler targets the chip's TCAM, hash tables, and metadata pipelines. C++ does not directly write P4, but C++ host code populates P4 tables at runtime via the IPDK or P4Runtime gRPC API.

Sample P4 fragment for an L3 forwarder:

```p4
table ipv4_lpm {
    key = { hdr.ipv4.dst_addr : lpm; }
    actions = { drop; forward; }
    size = 1024;
}
apply { if (hdr.ipv4.isValid()) ipv4_lpm.apply(); }
```

Host C++ then calls `p4runtime_install_entry(table_id, {dst=10.0.0.0/8, action=forward, port=1})` at runtime to populate the table.

### What To Offload

A useful taxonomy:

- **Always offload to DPU.** L2/L3 forwarding, VXLAN/Geneve encap-decap, IPSec, TLS, RDMA, NVMe-over-Fabric. These are infrastructure functions the host should not see.
- **Offload selectively.** Application firewalls, load balancers, telemetry, DPI. Depends on which features the DPU supports.
- **Keep on host.** Application logic, complex state. The DPU has fewer cores at lower clock, the cycles are precious.

The DPU is also a great place for "infra observability": all packets pass through, stamp them with a hardware timestamp, sample at flow level, push aggregates to a control plane via the DPU's out-of-band interface.

### DPU + Host Interaction Model

In a typical BlueField deployment, the host sees the DPU's host-facing port as a regular NIC (called the "PF" or "VF"). The host runs DPDK against it. The DPU runs DOCA Flow rules that decide what reaches the host. The DPU also has its own ARM cores running additional services: a bare-metal hypervisor, a custom firewall daemon, telemetry collectors.

The two halves communicate via:
- The Ethernet datapath (host writes packet to DPU, DPU forwards or transforms).
- A PCIe out-of-band channel (control plane RPC, typically over an internal Ethernet between host and DPU SoC).
- Shared memory regions registered as RDMA MRs across the PCIe boundary.

For a C++ engineer, the mental model is "the DPU is a separate Linux box that happens to be inside the chassis, connected by a fast cable." Most networking development happens on one side or the other, cross-DPU coordination is a higher-layer concern.

### When DPU Does Not Help

- **Latency-critical L7 application logic.** The DPU adds a hop on every packet. For HFT, the DPU is the wrong place, the application needs direct NIC access.
- **Single-threaded performance.** DPU ARM cores are slower than modern x86. CPU-bound pipelines that fit in one core run faster on the host.
- **Tiny deployments.** A DPU costs \$2K - \$3K. For a 4-server deployment with 25 Gbit links, the host can absorb the work.

The DPU is a hyperscale tool. At rack scale and above it is transformative, below that it adds operational complexity for marginal benefit.

> Junior engineer take: "We should put a DPU in every server because they make networking fast."
> Senior FAANG move: identify the specific functions that consume host CPU at scale (typically VXLAN encap/decap, encryption, security groups), validate the DPU supports them at line rate, design the host-DPU split with clear ownership, and benchmark host-CPU savings against DPU TCO before scaling out.
