#!/bin/sh

case "$1" in
  1)
    printf '/\000'
    ;;
  2)
    printf 'aera-release-source-full-scan\000/\000'
    ;;
  *)
    exit 1
    ;;
esac
