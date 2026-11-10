FROM node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152 AS node
FROM python:3.14.0-slim-bookworm@sha256:d13fa0424035d290decef3d575cea23d1b7d5952cdf429df8f5542c71e961576

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && printf '%s\n' \
        'pytest==9.0.2 --hash=sha256:711ffd45bf766d5264d487b917733b453d917afd2b0ad65223959f59089f875b' \
        'iniconfig==2.3.0 --hash=sha256:f631c04d2c48c52b84d0d0549c99ff3859c98df65b3101406327ecc7d53fbf12' \
        'packaging==25.0 --hash=sha256:29572ef2b1f17581046b3a2227d5c611fb25ec70ca1ba8554b24b0e69331a484' \
        'pluggy==1.6.0 --hash=sha256:e920276dd6813095e9377c0bc5566d94c932c33b27a3e3945d8389c374dd4746' \
        'pygments==2.19.2 --hash=sha256:86540386c03d588bb81d44bc3928634ff26449851e99741617ecb9037ee5ec0b' \
        > /tmp/sandbox-requirements.txt \
    && python -m pip install --no-cache-dir --require-hashes -r /tmp/sandbox-requirements.txt \
    && rm /tmp/sandbox-requirements.txt \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp sandbox \
    && mkdir /workspace && chown 10001:10001 /workspace
USER 10001:10001
WORKDIR /workspace
