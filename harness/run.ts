const scenario = process.argv[2];
if (process.argv.length !== 3 || !scenario || !/^[a-z][a-z0-9-]*$/.test(scenario)) {
  console.error("Usage: pnpm harness <scenario>");
  process.exitCode = 1;
} else {
  try {
    const loaded: unknown = await import(`./scenarios/${scenario}.ts`);
    if (
      !loaded ||
      typeof loaded !== "object" ||
      !("default" in loaded) ||
      typeof loaded.default !== "function"
    ) {
      throw new Error("Scenario must export a default function");
    }
    await loaded.default();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
