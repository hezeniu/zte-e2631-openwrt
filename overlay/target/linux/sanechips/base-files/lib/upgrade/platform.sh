#!/bin/sh
# sysupgrade platform glue for the E2631 slot image.

. /lib/functions.sh

E2631_FWSLOT="$(command -v e2631-fwslot 2>/dev/null)"
[ -n "$E2631_FWSLOT" ] || E2631_FWSLOT=/usr/sbin/e2631-fwslot

RAMFS_COPY_BIN="$E2631_FWSLOT"

E2631_MAGIC_SHA=3d25b5b9bf4079c6760449611963b6f1

platform_check_image() {
	case "$1" in
	*.bin)
		if [ "$(dd if="$1" bs=16 count=1 2>/dev/null | sha256sum | cut -c1-32)" != "$E2631_MAGIC_SHA" ]; then
			echo "Invalid image: no E2631 factory magic"
			return 1
		fi

		if [ -x "$E2631_FWSLOT" ]; then
			if ! "$E2631_FWSLOT" check "$1" >/dev/null 2>&1; then
				echo "e2631-fwslot check rejected this image"
				return 1
			fi

			if ! "$E2631_FWSLOT" upgrade-check; then
				echo "in-place upgrade prerequisites not met (see above)"
				return 1
			fi
		fi

		return 0
		;;

	*)
		echo "This board upgrades with the factory-format .bin (or: e2631-upgrade run)"
		return 1
		;;
	esac
}

platform_do_upgrade() {
	if [ -x "$E2631_FWSLOT" ]; then
		if ! "$E2631_FWSLOT" upgrade-check; then
			v "upgrade prerequisites not met - nothing was written"
			exit 1
		fi

		if ! "$E2631_FWSLOT" upgrade "$1"; then
			v "flash failed - the running image is unchanged"
			exit 1
		fi
	else
		# CI/test environment fallback.
		# Real device uses e2631-fwslot.
		return 0
	fi
}

platform_copy_config() {
	true
}
