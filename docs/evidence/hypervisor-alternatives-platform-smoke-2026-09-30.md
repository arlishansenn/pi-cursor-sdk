# Research: free alternatives to Parallels (`prlctl`) for platform smoke

## Summary

On this Apple Silicon Mac (`arm64`, macOS 26.6.2) no hypervisor CLI is installed. The cheapest path that still runs `npm run smoke:platform:all` is **leave the gate uncommitted / not run**. Replacing Parallels is not a `prlctl` shim: Crabbox’s Windows lane is hard-wired to `--provider parallels`, and that provider creates linked clones with `prlctl` from a powered-off snapshot. VMware Fusion Pro is $0 for personal and commercial use but needs a Broadcom account and a new Crabbox provider. UTM, VirtualBox, QEMU, Multipass, and Lima cannot drop in.

## Findings

1. **This machine.** `uname -m` = `arm64`, Darwin, macOS 26.6.2 (25G83). `prlctl`, `VBoxManage`, `utmctl`, `multipass`, `limactl`, `colima`, `qemu-system-aarch64`, and `qemu-img` are absent from PATH. Observed 2026-09-30.

2. **What the gate actually calls.** Direct `prlctl` is only in `scripts/platform-smoke/doctor.mjs` (about lines 328–403):
   - `prlctl list -a --no-header` — VM exists and column 2 is `stopped`
   - `prlctl snapshot-list "<vm>" -j` — snapshot name unique and `state === "poweroff"`; text `snapshot-list` is only a name fallback
   - `prlctl list -f --no-header "<vm>"` — IP is field 3; `-` means “no IP”, then a disposable Crabbox clone is probed
   - failure text also mentions `prlctl snapshot "<vm>" --name "<snap>"` (not executed)
   The suite runner never calls `prlctl`. `scripts/platform-smoke/crabbox-runner.mjs` `windows-native` always passes `--provider parallels` plus `--parallels-source`, `--parallels-source-snapshot`, `--parallels-user`, `--parallels-work-root`. Doctor also requires the Crabbox provider registry to list `parallels` (`doctor.mjs` ~255). macOS is SSH to localhost; Ubuntu is Docker `local-container`. Neither needs a hypervisor. Contract: `docs/platform-smoke.md` checks 8–12 and the target table (`windows-native` = `parallels`).

3. **Crabbox will not accept a foreign hypervisor under the Parallels provider.** Upstream docs: Parallels “asks `prlctl` to create a clone from a configured source VM (and, for linked mode, a snapshot)” and “Linked clones require an explicit power-off snapshot.” Local providers that exist today are `local-container`, `apple-container`, `apple-vm` (Linux only), `multipass` (“Ubuntu-only first implementation”), `tart` (macOS VMs), and `hyperv` (Windows host only). No `utm`, `qemu`, `virtualbox`, `vmware`, or `fusion` provider in the generated matrix. https://github.com/openclaw/crabbox/blob/main/docs/providers/parallels.md and https://github.com/openclaw/crabbox/blob/main/docs/providers/README.md

4. **Parallels stays paid.** Official buy page: Standard and Pro are subscriptions; Pro is the row that includes “Command line interface”; Standard is “Light home use” and does not list CLI. Trial KB: “Try Free for 14 days”; “The period cannot be extended”; trial includes Standard and Pro features. Dollar amounts are not in the fetched text (page is JS-priced). https://www.parallels.com/products/desktop/buy/ https://kb.parallels.com/en/124227

5. **VMware Fusion Pro is the only free full hypervisor, and it is not a drop-in.** Broadcom: Fusion Pro is “free for commercial, educational, and personal use. You no longer require a license key” (26H1 using guide). KB 368667 (2024-11-11): free for commercial, educational, and personal users from Fusion 13.5.2 up; download requires a Broadcom Support Portal account, profile, and trade-compliance form; installer offers “FINISH (For free version)”. There is no separate paid “standard” product in these pages; Fusion Pro is the free product. `vmrun` (Fusion Pro 25H2/13 docs): `start <vmx> nogui`, `list` (running only — not all VMs), `listSnapshots <vmx>`, `snapshot <vmx> <name>`, `revertToSnapshot`, `getGuestIPAddress <vmx> [-wait]`, and Pro-only `clone ... full|linked [-snapshot=Name]`. https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/fusion-pro/26H1/using-vmware-fusion.html https://knowledge.broadcom.com/external/article/368667/download-and-license-vmware-desktop-hype.html https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/fusion-pro/25H2/using-vmware-fusion/using-the-vmrun-command-to-control-virtual-machines/running-vmrun-commands/syntax-of-vmrun-commands.html

6. **VirtualBox is free for the base package, not a Windows-lane replacement here.** Base package GPLv3, including Guest Additions. Extension Pack is PUEL for personal/educational use only; commercial use is paid and not redistributable. Smoke does not need the Extension Pack (VRDP, webcam, PXE, disk encryption, cloud). 7.1 known limits for macOS/Arm64 hosts: “x86-based guest operating systems will not run”; “Arm(AArch64) guests only”; limits on sound, storage, graphics, guest additions, and unattended install. Guest Additions do list Windows 11 on Arm64 VMs. CLI exists: `VBoxManage list vms`, `startvm --type headless`, `snapshot list|take|restore`, `guestproperty get ... /VirtualBox/GuestInfo/Net/0/V4/IP` (needs Guest Additions). https://www.virtualbox.org/wiki/Licensing_FAQ https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/Introduction.html https://docs.oracle.com/en/virtualization/virtualbox/7.1/user/KnownIssues.html https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/guestadditions.html

7. **UTM is free and can boot Windows ARM, but has no snapshot CLI.** `LICENSE` in the repo is Apache-2.0 (“no-charge, royalty-free”). The app bundles (L)GPL QEMU; the project license page is https://mac.getutm.app/licenses/. `utmctl` is an AppleScript wrapper at `/Applications/UTM.app/Contents/MacOS/utmctl`. Documented verbs: list/status, start, stop, suspend. `query ip` exists only when the QEMU guest agent is running. The scripting dictionary has **no snapshot command** (searched the reference). Headless means delete the display device, and “UTM needs to be open”. https://github.com/utmapp/UTM/blob/master/LICENSE https://docs.getutm.app/scripting/scripting/ https://docs.getutm.app/scripting/reference/ https://docs.getutm.app/advanced/headless/

8. **Multipass covers Ubuntu only, and the repo already covers Ubuntu with Docker.** README: “spin up a fresh Ubuntu environment”; macOS backend is QEMU (or VirtualBox). Official CLI includes `list`, `info` (IP), `start`, `snapshot`, `restore`. GPL-3.0 on the GitHub repo. It cannot host the Windows lane. https://github.com/canonical/multipass https://raw.githubusercontent.com/canonical/multipass/main/README.md https://documentation.ubuntu.com/multipass/latest/reference/command-line-interface https://documentation.ubuntu.com/multipass/latest/reference/command-line-interface/snapshot/

9. **Lima/Colima do not cover this Windows lane.** Lima README: “launches Linux virtual machines”. Colima is “Docker (and Kubernetes) on macOS”, which is another backend for the existing Ubuntu container lane, not a third OS. Lima’s Windows mentions in the internals doc are host-path / install-marker notes, not a supported guest product. Snapshot CLI: **not stated** on the VM-type docs fetched. https://github.com/lima-vm/lima/blob/master/README.md https://lima-vm.io/docs/config/vmtype/ https://github.com/abiosoft/colima/discussions/491 (maintainer: not meant to be used on Windows; do not treat as a guest-OS promise)

10. **QEMU direct has the primitives and none of the product.** Emulator is GPLv2 (`qemu/qemu` `LICENSE`). Monitor: `savevm`/`loadvm`/`info snapshots` (qcow2 internal snapshots). Guest IP is not a monitor command; it needs the guest agent (`guest-network-get-interfaces`) plus a host-side socket. No VM registry equivalent to `prlctl list -a`. Headless is `-display none` / `-nographic`. Usable only as a custom runner, not a shim. https://raw.githubusercontent.com/qemu/qemu/master/LICENSE https://www.qemu.org/docs/master/system/monitor.html

11. **Windows ARM on this Mac is a real OS, not a free licensed dev VM.** Microsoft documents Arm64 ISOs for “create virtual machines on local devices” and explicitly includes “Arm-based Apple device”. That page does not grant a license. Evaluation Center lists “Windows 11 Enterprise, version 25H2 | x64 ISO and Arm64 ISO” as a 90-day evaluation. Retail activation terms for a long-lived template were **not** established from a primary license page in this pass. https://learn.microsoft.com/en-us/windows/arm/iso https://www.microsoft.com/en-us/software-download/windows11arm64 https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise

### Command map (smoke surface only)

| Need | prlctl (used) | vmrun | VBoxManage | utmctl | multipass | QEMU |
|---|---|---|---|---|---|---|
| List VMs | `list -a --no-header` | `list` = running only | `list vms` | list via CLI/AppleScript | `list` (Ubuntu) | none |
| Headless start | not called by doctor; Crabbox starts clones | `start <vmx> nogui` | `startvm <vm> --type headless` | start; headless needs no display; app stays open | `start` | `-display none` |
| List snapshots | `snapshot-list <vm> -j` (needs JSON + `state=poweroff`) | `listSnapshots <vmx>` (tree text, no power state) | `snapshot <vm> list` | **none** | snapshot settings via `get`/`info`; exact list syntax not quoted here | monitor `info snapshots` |
| Take / restore | doctor only prints `snapshot <vm> --name` | `snapshot` / `revertToSnapshot` | `snapshot take` / `snapshot restore` | **none** | `snapshot` / `restore` (stopped instance) | `savevm` / `loadvm` |
| Guest IP | `list -f` field 3, `-` if down | `getGuestIPAddress <vmx> [-wait]` (Tools) | `guestproperty get ... /VirtualBox/GuestInfo/Net/0/V4/IP` (Additions) | `query ip` (QEMU guest agent only) | `info <name>` | guest agent, not a stock CLI |
| Linked clone from power-off snapshot | Crabbox via `prlctl` | `clone ... linked -snapshot=Name` (Pro) | clone exists; linked-from-snapshot parity **unknown** | **none** | `clone` of Ubuntu instances; not Windows | disk-image only |

### Repo change size

| Option | Files | Depth |
|---|---|---|
| Keep gate unrun | none | 0 |
| Swap `prlctl` strings only | `doctor.mjs` | Useless. Runner still passes `--provider parallels`. |
| New hypervisor, same Crabbox | `doctor.mjs`, `crabbox-runner.mjs`, `platform-smoke.config.mjs`, `docs/platform-smoke.md`, tests that lock `buildTargetBaseArgs("windows-native")` (`test/platform-smoke-artifact-transport.test.ts`) | Blocked until Crabbox ships a provider. Forking Crabbox is out of scope. |
| Fusion + new provider | above, plus a Crabbox provider that speaks `vmrun` linked clones | Largest. Not a shim. |
| Drop Windows lane | config `requiredTargets`, doctor phases 3 and 6, runner case, docs, tests | Medium, and it no longer matches the documented three-lane gate. |

## Sources

- Kept: Broadcom Using Fusion Pro 26H1 (https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/fusion-pro/26H1/using-vmware-fusion.html) — free for personal and commercial, no key.
- Kept: Broadcom KB 368667 (https://knowledge.broadcom.com/external/article/368667/download-and-license-vmware-desktop-hype.html) — account + trade form; free since 13.5.2.
- Kept: vmrun syntax, Fusion Pro 25H2 (https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/fusion-pro/25H2/using-vmware-fusion/using-the-vmrun-command-to-control-virtual-machines/running-vmrun-commands/syntax-of-vmrun-commands.html) — command surface.
- Kept: VirtualBox Licensing FAQ (https://www.virtualbox.org/wiki/Licensing_FAQ) — GPLv3 vs PUEL.
- Kept: VirtualBox 7.1 known limitations (https://docs.oracle.com/en/virtualization/virtualbox/7.1/user/KnownIssues.html) — Apple silicon guest limits.
- Kept: VirtualBox Guest Additions 7.2 (https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/guestadditions.html) — Windows 11 Arm64 + `GuestInfo/Net/0/V4/IP`.
- Kept: UTM LICENSE (https://github.com/utmapp/UTM/blob/master/LICENSE) — Apache-2.0.
- Kept: UTM scripting reference (https://docs.getutm.app/scripting/reference/) — no snapshot verb; `query ip`.
- Kept: Multipass CLI + snapshot (https://documentation.ubuntu.com/multipass/latest/reference/command-line-interface) — Ubuntu manager with snapshots.
- Kept: Lima README (https://github.com/lima-vm/lima/blob/master/README.md) — Linux VMs.
- Kept: QEMU LICENSE (https://raw.githubusercontent.com/qemu/qemu/master/LICENSE) — GPLv2 emulator.
- Kept: Crabbox provider matrix + Parallels provider (https://github.com/openclaw/crabbox/blob/main/docs/providers/README.md) — parallels is `prlctl` linked clones; no UTM/Fusion provider.
- Kept: Parallels trial KB (https://kb.parallels.com/en/124227) — 14 days, not extendable.
- Kept: Parallels buy page (https://www.parallels.com/products/desktop/buy/) — CLI is a Pro-row feature.
- Kept: Microsoft Windows on Arm ISO (https://learn.microsoft.com/en-us/windows/arm/iso) — Apple silicon VMs supported; license not granted.
- Dropped: search-result summaries and Q&A forum threads — not primary, and several misstated commands.
- Dropped: https://www.qemu.org/license.html — website content license, not the emulator.
- Dropped: Lima Windows PR pages — POC/scaffolding, not a released guest product.

## Recommendation

Leave `smoke:platform:all` unrun on this machine. macOS and Ubuntu lanes do not need Parallels; the Windows lane does, and it needs a Pro-level `prlctl` plus a prepared stopped template, not just a binary on PATH. If a free hypervisor must be installed later, Fusion Pro is the only one that is both $0 for commercial use and has list/start-headless/snapshot/IP/linked-clone commands — and it still needs a Broadcom account plus a new Crabbox provider. UTM is the least-friction free GUI for a manual Windows ARM VM and cannot feed this gate.

## Gaps

- Parallels current dollar price: buy page did not render numbers.
- Whether today’s free Fusion build still ships `vmrun clone -snapshot` on Apple silicon, and whether a Windows ARM guest reports an IP before VMware Tools: documented in 25H2, not executed here.
- VirtualBox linked-clone-from-named-snapshot parity with Parallels: not verified.
- Lima snapshot command and any supported Windows guest: not in the pages fetched.
- A durable Windows 11 ARM license for a template VM, beyond the 90-day Enterprise eval: not established.
- Nothing was installed. No VM was created. No repo code was changed.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "research.md states leave the gate unrun, with Fusion Pro as the only later free hypervisor and the Crabbox parallels binding as the blocker"
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "uname -m && sw_vers",
      "result": "passed",
      "summary": "arm64, macOS 26.6.2 (25G83); no hypervisor CLIs on PATH"
    }
  ],
  "validationOutput": [
    "doctor.mjs prlctl surface and crabbox-runner --provider parallels confirmed in-repo"
  ],
  "residualRisks": [
    "Fusion Apple silicon Windows ARM linked-clone behavior was not executed",
    "Parallels current price and a durable Windows ARM license were not established from primary pages"
  ],
  "noStagedFiles": true,
  "diffSummary": "research brief only; no repo edits",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "Parent asked for docs/evidence/...; this run's authoritative output is the subagent research.md path. No software installed."
}
```
