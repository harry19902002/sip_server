#!/bin/sh
set -eu

mkdir -p /data /media /sip-directory
chown -R node:node /data /media /sip-directory

exec su-exec node:node "$@"
