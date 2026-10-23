import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const database = process.env.PARKING_TEST_DATABASE;
  if (!database || dirname(resolve(database)) !== join(repository, ".cache")
      || !/^monitoring-e2e-[a-f0-9-]+\.sqlite3$/.test(basename(database))) {
    throw new Error("Missing or unsafe isolated browser-test database path");
  }
  execFileSync("uv", [
    "run", "--directory", repository, "--no-sync", "parking", "smoke",
    "--output", join(repository, "viewer", "public", "test-fixture"), "--replace-synthetic",
  ], {
    cwd: repository,
    env: {
      ...process.env,
      UV_CACHE_DIR: join(repository, ".cache", "uv"),
      UV_PYTHON_INSTALL_DIR: join(repository, ".cache", "python"),
    },
    stdio: "pipe",
  });
  const stamped = process.env.PARKING_TEST_METADATA_VIDEO;
  if (stamped !== database.replace(/\.sqlite3$/, "-timestamp.mp4")) {
    throw new Error("Unsafe timestamp fixture path");
  }
  execFileSync("uv", [
    "run", "--directory", repository, "--no-sync", "python", "-c",
    [
      "import av, sys",
      "with av.open(sys.argv[1]) as source, av.open(sys.argv[2], 'w') as target:",
      "    target.metadata['creation_time'] = '2026-01-15T08:00:00Z'",
      "    stream = target.add_stream_from_template(source.streams.video[0])",
      "    for packet in source.demux(video=0):",
      "        if packet.dts is not None:",
      "            packet.stream = stream",
      "            target.mux(packet)",
    ].join("\n"),
    join(repository, "viewer", "public", "test-fixture", "media", "fixture.mp4"), stamped,
  ], { cwd: repository, stdio: "pipe" });
}
