#!/bin/sh
set -eu
# Only website backend ports are filtered. Install this script as a root-owned file.
for tool in iptables ip6tables; do
    "$tool" -w -N EUNNOTE_WEB 2>/dev/null || true
    "$tool" -w -C EUNNOTE_WEB -i lo -j RETURN 2>/dev/null || "$tool" -w -A EUNNOTE_WEB -i lo -j RETURN
    "$tool" -w -C EUNNOTE_WEB -p tcp -m multiport --dports 6357,6358 -j REJECT --reject-with tcp-reset 2>/dev/null || "$tool" -w -A EUNNOTE_WEB -p tcp -m multiport --dports 6357,6358 -j REJECT --reject-with tcp-reset
    "$tool" -w -C INPUT -j EUNNOTE_WEB 2>/dev/null || "$tool" -w -I INPUT 1 -j EUNNOTE_WEB
done
