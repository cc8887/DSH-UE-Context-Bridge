# Zero-base install test for @ue-bridge/bundle.
#
# Purpose: prove the release tarball installs on a machine that has never seen
# this repo. The host's node_modules must not be reachable, otherwise a missing
# dependency resolves by accident and the test passes for the wrong reason.
#
# dsh is installed fresh here rather than mounted from the host, so its bundled
# dsh-tools/cordis are the container's own -- exactly what a real user has.
#
# The registry must be set explicitly. The container can reach the internal
# mirror but not registry.npmjs.org, and npm defaults to the latter, so an
# unset registry turns every install into a multi-minute timeout instead of a
# fast, diagnosable failure.
FROM docker.io/library/node:22-slim

ARG NPM_REGISTRY=https://mirrors.tencent.com/npm/
ENV DSH_HOME=/root/.dsh

RUN npm config set registry "$NPM_REGISTRY"

# pnpm is what dsh uses to add profile plugins; installing without it would
# make the test diverge from the real install path.
RUN npm install -g pnpm@10 @deepseek-ai/dsh@0.1.5-rc.3

WORKDIR /work

# The tarball is copied, not downloaded: a network fetch would test the CDN
# instead of the artifact. Swap this file to test a different build.
COPY ue-bridge-bundle-0.1.0.tgz /work/bundle.tgz

COPY run-test.sh /work/run-test.sh
RUN chmod +x /work/run-test.sh

CMD ["/work/run-test.sh"]
