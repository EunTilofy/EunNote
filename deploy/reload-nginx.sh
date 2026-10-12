#!/bin/sh
set -eu
exec /bin/systemctl reload nginx.service
