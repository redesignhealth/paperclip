# Stub agent runtime for the kind CI test. It satisfies the sandbox-cr pod contract
# (tini at /usr/bin/tini, /bin/sh, tar, find, uid 1000, /home/paperclip) and ships a
# fake `pi` that needs no model credentials.
FROM alpine:3.20
RUN apk add --no-cache tini tar findutils coreutils \
 && ln -sf /sbin/tini /usr/bin/tini \
 && adduser -D -u 1000 -h /home/paperclip paperclip \
 && mkdir -p /workspace /home/paperclip/.cache /deps \
 && chown -R 1000:1000 /workspace /home/paperclip /deps
COPY pi /usr/local/bin/pi
USER 1000:1000
WORKDIR /workspace
