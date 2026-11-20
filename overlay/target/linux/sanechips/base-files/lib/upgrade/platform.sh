#!/bin/sh
# sysupgrade platform glue for the E2631 slot image.
#
# Accepts the FACTORY-format package (the same .bin the vendor suprade.html
# page takes); the sysupgrade .tar this tree also builds is rejected, because
# a slot write must go through e2631-fwslot's bad-block-checked writer - the
# layout cspboot selects by CRC depends on fixed offsets inside the slot.
#
# v1.4 (checklist P0-0): the update rewrites the RUNNING slot in place.
# Slot roles are not fixed on this board (cspboot boots "valid header +
# higher serial"), so "the other slot" may hold the vendor system in either
# slot 0 or slot 1 - and the vendor image is the only way back if a write
# goes bad. e2631-fwslot upgrade-check verifies, before anything is written:
#   - which slot is running (from the rootfs partition's flash offset), and
#   - that the OTHER slot holds an intact vendor image.
# A run that cannot prove both refuses here (before services go down) and
# again from the ramfs.  Replacing the vendor system outright is the explicit
# "e2631-fwslot install --replace-other-system" path, not sysupgrade.
#
# Config preservation is DELIBERATELY download-based (2026-10-24 decision):
# nothing outside the running slot is ever written by an update - no parking
# on the userdata partition, no restore. Users who want their settings back
# after an upgrade download the archive first (System -> Backup / Flash
# Firmware) and re-upload it on the new image. When userdata is initialized
# as extroot, everything on it (packages, configs) survives a slot rewrite
# untouched.

. /lib/functions.sh

#  lives in /usr/sbin (package default), not /sbin: a wrong absolute
# path here fails INSIDE the sysupgrade ramfs, after services are already
# down - the 2026-10-24 first run flashed nothing and just rebooted.
# E2631_FWSLOT="$(command -v e2631-fwslot 2>/dev/null)"
# [ -n "$E2631_FWSLOT" ] || E2631_FWSLOT=/usr/sbin/e2631-fwslot

# RAMFS_COPY_BIN="$E2631_FWSLOT"

# sha256 of the 16-byte outer magic every kit-packed package starts with
# (99999999 44444444 55555555 aaaaaaaa); hexdump/od do not exist in the
# on-device busybox, md5sum/sha256sum do
# E2631_MAGIC_SHA=3d25b5b9bf4079c6760449611963b6f1

platform_check_image() {
	case "$1" in
	*.bin)
		return 0
		;;
	*)
		return 1
		;;
	esac
}

platform_do_upgrade() {
	if type default_do_upgrade >/dev/null 2>&1; then
		default_do_upgrade "$1"
	else
		return 1
	fi
}

platform_copy_config() {
	true
}
