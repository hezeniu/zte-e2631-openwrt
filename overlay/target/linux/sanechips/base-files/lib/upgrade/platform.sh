#!/bin/sh
#
# Platform upgrade support for ZX279127S OpenWrt
#

. /lib/functions.sh

platform_check_image() {
	[ -f "$1" ] || {
		echo "Image not found: $1"
		return 1
	}

	case "$1" in
	*.bin)
		return 0
		;;

	*)
		echo "Only .bin firmware images are supported."
		return 1
		;;
	esac
}

platform_do_upgrade() {
	default_do_upgrade "$1"
}

platform_copy_config() {
	true
}
