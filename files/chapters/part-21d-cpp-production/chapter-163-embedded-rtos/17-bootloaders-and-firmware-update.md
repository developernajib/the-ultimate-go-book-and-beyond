## Bootloaders and Firmware Update

Every connected embedded device needs to update its firmware in the field. A car's ECU receives updates over the cellular network. A Nest thermostat receives them over Wi-Fi. A Ring doorbell pulls them from AWS S3. A Falcon 9 first stage uplinks updates from ground stations between flights. The mechanics are the same: download a new image, verify it, install it, and roll back if it fails to boot.

This chapter is about how that pipeline is built and what the C++ side looks like.

### The Boot Chain

A modern secure embedded device has a boot chain rooted in immutable hardware:

1. **Mask ROM.** Burned into silicon at fabrication. Contains the first-stage bootloader. Cannot be modified.
2. **First-stage bootloader (FSBL).** Loaded from a secure boot region of flash. Verifies the second-stage bootloader before jumping to it.
3. **Second-stage bootloader (SSBL).** Performs the firmware update logic, A/B selection, and verifies the application image.
4. **Application.** The firmware that runs the product.

Each link verifies the next. The mask ROM holds the public key (or its hash) for verifying the FSBL. The FSBL holds the public key for verifying the SSBL. The SSBL holds the public key for verifying the application. Modifying any image requires the corresponding private key, which lives in an HSM at the OEM.

### Root of Trust

The root of trust is the first verification step. It is typically:

- A hash of the FSBL public key burned into one-time-programmable (OTP) fuses
- A signed certificate stored in flash, signed by a certificate burned in OTP
- A HW security peripheral (Apple Secure Enclave, NXP Edge Lock, Microchip ATECC608, ST33) that holds keys and performs verification

The mask ROM reads the OTP, computes the hash of the FSBL on flash, compares signatures, and only jumps if they match. If the FSBL has been tampered with, the part bricks itself before any modified code runs.

### Signed Images

A typical signed image format:

```
+-----------------+
| Header          |  version, length, flags
+-----------------+
| Public key info |  optional, for chained verification
+-----------------+
| Image           |  the actual firmware bytes
+-----------------+
| Signature       |  ECDSA P-256 over header+image
+-----------------+
```

The bootloader verifies the signature before transferring control. ECDSA P-256 is the most common choice in 2026 because:

- Signature size is 64 bytes, manageable on flash
- Verification on Cortex-M4 takes 50-150 ms with hardware acceleration, acceptable
- Quantum-resistant alternatives (Dilithium, Falcon) are emerging in NIST PQC but not yet standardized in firmware tooling

The signature header in C++:

```cpp
struct ImageHeader {
    std::uint32_t magic;          // 0x4D434255 for "MCBU"
    std::uint32_t version;
    std::uint32_t image_size;     // bytes following the header
    std::uint32_t flags;
    std::uint8_t  sha256[32];     // hash of image bytes
    std::uint8_t  signature[64];  // ECDSA P-256
};
static_assert(sizeof(ImageHeader) == 144);

bool verify_image(const ImageHeader* hdr, const std::uint8_t* image_bytes) {
    if (hdr->magic != 0x4D434255) return false;
    std::uint8_t computed[32];
    sha256(image_bytes, hdr->image_size, computed);
    if (std::memcmp(computed, hdr->sha256, 32) != 0) return false;
    return ecdsa_verify_p256(g_root_pubkey,
                             hdr->sha256, 32,
                             hdr->signature);
}
```

### MCUboot

MCUboot is the de facto open-source bootloader for IoT MCUs. It is hosted by the Linux Foundation, used in Zephyr by default, integrated in Nordic nRF Connect SDK, and supported by NuttX. It implements signed images, A/B partitioning, swap-on-reset upgrade, and anti-rollback.

A typical flash layout for MCUboot:

```
+-------------------+ 0x00000000
| MCUboot itself    |  32 KB, signed by FSBL or fixed
+-------------------+ 0x00008000
| Primary slot      |  application image, currently running
| (image header,    |
|  application,     |
|  trailer)         |
+-------------------+ 0x00080000
| Secondary slot    |  staged update or backup of previous
+-------------------+ 0x000F8000
| Scratch area      |  used during swap
+-------------------+ 0x00100000
```

The application uses the secondary slot to stage a downloaded update. On reboot, MCUboot verifies the staged image, swaps slots (so the secondary becomes primary), and boots the new image. If the new image fails to confirm itself within a window (typically a single boot), MCUboot swaps back on the next reset.

The C++ side of staging:

```cpp
#include "flash_map_backend/flash_map_backend.h"

bool stage_update(std::span<const std::uint8_t> image) {
    const flash_area* area;
    int rc = flash_area_open(FLASH_AREA_IMAGE_SECONDARY(0), &area);
    if (rc != 0) return false;

    rc = flash_area_erase(area, 0, image.size());
    if (rc != 0) { flash_area_close(area); return false; }

    rc = flash_area_write(area, 0, image.data(), image.size());
    flash_area_close(area);

    if (rc != 0) return false;

    // Mark as test boot. MCUboot will swap on next reset.
    boot_set_pending(false);

    NVIC_SystemReset();   // never returns
    return true;
}
```

After the reboot, the new firmware should call `boot_set_confirmed()` once it has verified its own functionality. If it does not, MCUboot swaps back on the next reboot.

### A/B Partitioning vs Swap

There are two firmware update strategies on a single MCU:

**Swap-on-reset.** Two slots. The bootloader physically swaps the contents using the scratch area. After swap, the new image is in slot A and the old image in slot B. Used by MCUboot in default configuration. Robust against power loss during swap (the swap is journaled). Slow because every page is moved twice.

**A/B (dual-bank).** Two slots. The bootloader chooses which slot to boot based on a pointer or a "current slot" indicator in non-volatile storage. The image is downloaded directly to the inactive slot. No physical swap. Faster than swap-on-reset, requires double the flash (because both slots are full size at all times).

Most automotive ECUs use A/B because the disk space is plentiful and the update must be fast. Most consumer IoT uses swap-on-reset because flash is the BOM cost driver and swap saves half the flash.

### Anti-Rollback

A signed update prevents an attacker from installing forged firmware. It does not prevent installing a legitimately signed older firmware that has known vulnerabilities. Anti-rollback is the mitigation.

Each image declares a security version number (SVN), independent of the user-facing version. The bootloader keeps the highest SVN ever observed in OTP fuses or in a counter peripheral. An update with a lower SVN is rejected.

```cpp
struct ImageMetadata {
    std::uint32_t user_version;       // displayed to users: 2.4.1
    std::uint32_t security_version;   // anti-rollback counter, monotonic
    std::uint8_t  build_hash[20];
};

bool boot_check_svn(const ImageMetadata* meta) {
    std::uint32_t min_svn = read_otp_security_version();
    return meta->security_version >= min_svn;
}

void boot_commit_svn(const ImageMetadata* meta) {
    if (meta->security_version > read_otp_security_version()) {
        write_otp_security_version(meta->security_version);
    }
}
```

The OTP fuse counter has a finite number of writes (typically 32 to 256). An OEM allocates SVN bumps carefully: a critical security fix bumps SVN, a routine feature update does not. SpaceX firmware is known to bump SVN aggressively because the cost of a downgrade attack outweighs the cost of OTP fuses.

### OTA Download

The application downloads the update over the air. The mechanics depend on the connectivity:

- **Wi-Fi**: HTTPS download from S3 or a CDN
- **Cellular**: AWS IoT MQTT broker streaming chunks, or LwM2M FOTA
- **BLE**: a phone app pushes the image over a custom GATT service
- **CAN**: ISO 14229 UDS protocol for automotive ECUs

Each chunk is verified incrementally. If the connection drops mid-download, the firmware resumes from the last verified offset.

```cpp
class OtaSession {
    std::uint32_t offset_ = 0;
    Sha256Stream hasher_;
    const flash_area* slot_;
public:
    bool start(std::uint32_t expected_size, std::span<const std::uint8_t> expected_hash) {
        flash_area_open(FLASH_AREA_IMAGE_SECONDARY(0), &slot_);
        flash_area_erase(slot_, 0, expected_size);
        return true;
    }
    bool feed(std::span<const std::uint8_t> chunk) {
        flash_area_write(slot_, offset_, chunk.data(), chunk.size());
        hasher_.update(chunk);
        offset_ += chunk.size();
        return true;
    }
    bool finalize(std::span<const std::uint8_t> expected_hash) {
        std::uint8_t computed[32];
        hasher_.finalize(computed);
        if (std::memcmp(computed, expected_hash.data(), 32) != 0) {
            flash_area_erase(slot_, 0, offset_);
            return false;
        }
        boot_set_pending(false);
        return true;
    }
};
```

The integrity check at finalize prevents committing a corrupt download.

### Failure Modes

What happens when an update fails:

- **Signature invalid**: the bootloader does not boot the new image, swaps back. User sees the old version still running. OTA reports failure to cloud.
- **Image corrupt mid-flash**: the trailer check fails on next boot. Bootloader treats the slot as empty and boots the previous image.
- **New image boots but hangs in init**: a watchdog reset. After N consecutive resets, the bootloader marks the new image as bad and swaps back. The "boot confirmed" handshake catches this.
- **New image boots and runs but a critical feature is broken**: the device flags itself for rollback via cloud command. Cloud pushes a new "rollback" command, the device swaps back.

For automotive ECUs, the requirements are stricter. The vehicle must remain drivable through the update process. The standard pattern is to update the ECU only when the vehicle is parked, with the engine off and the battery sufficiently charged, and to include a "stop and revert" path that is triggered by the user starting the engine mid-update.

### EU Cyber Resilience Act and FCC

As of 2026, two regulatory frameworks have made secure boot and signed updates mandatory for many product categories:

- **EU Cyber Resilience Act (CRA)**: requires manufacturers of "products with digital elements" to ensure security throughout the product lifecycle, including signed updates and timely security patches. Effective for new products from late 2027.
- **FCC Cyber Trust Mark**: voluntary US program but increasingly required by retailers. Mandates signed firmware, vulnerability disclosure, and update support.

The practical effect is that any IoT product shipping in 2026 or later must implement the boot chain described in this chapter. The C++ code is the same for a hobby project, but the certification requirements add documentation overhead, key management discipline, and a post-shipping vulnerability response process.

---
