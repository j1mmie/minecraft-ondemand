#!/bin/sh

TAG=$1

if [ -z "$TAG" ]; then
  echo "Usage: $0 <tag>. Example:"
  echo "  $0 0.0.1"
  echo "  $0 latest"

  exit 1
fi

docker buildx build -t "j1mmie/minecraft-ecsfargate-watchdog:$TAG" .

echo "Build complete. Push to Docker Hub with: "
echo "docker push j1mmie/minecraft-ecsfargate-watchdog:$TAG"
