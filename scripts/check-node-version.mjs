const major = Number(process.versions.node.split(".")[0]);

if (!Number.isSafeInteger(major) || major < 22) {
  console.error(
    "Node.js 22+ is required; found " + process.version + " at " + process.execPath + ".",
  );
  console.error(
    "Activate the repo's Node environment first, for example: conda activate codejam",
  );
  process.exit(2);
}
