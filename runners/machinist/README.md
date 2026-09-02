# Running Trekvaart on Machinist

[Machinist](https://github.com/owainlewis/machinist) is a job runner: a trigger starts one process in one repository with a prompt on stdin and a timeout, and records what happened. Trekvaart supplies the prompts. This directory holds an example configuration; Machinist's own schema has changed more than once in a week, so check it against the current [configuration guide](https://github.com/owainlewis/machinist/blob/main/docs/configuration.md) before use.

`config.example.toml` defines one command, `sluiswachter`, whose prompt file is `prompts/sluiswachter.md` in this repository. Point Machinist's worker at a clone of the repository you want built, and at a clone of this repository for the prompts.

The `trekvaart:requested` label on an issue is the trigger. Nothing in this repository fires on its own.
