# Contributing to jvmScout

Thanks for your interest in improving jvmScout! This project is a four-tier JVM
exception-monitoring platform (native agent, BCI transformer, Python collector,
web UI). Contributions of all kinds are welcome — bug reports, fixes, docs, and
features.

## Ground rules

- **The agent must never crash the host JVM.** Every JVMTI/JNI callback body
  stays wrapped in `try/catch`, every BCI transform failure returns `null`
  ("leave bytecode unchanged"), and RAII owns all JVMTI/JNI resources. See
  `PLAN.md` §2 for the full list of non-negotiable invariants — PRs that violate
  them will not be merged.
- Keep OS-specific code behind `ITransport` / `platform.h`. Portable code stays
  portable.
- Match the style and structure of the surrounding code.

## Development setup

See [`README.md`](README.md) for full build and run instructions. In short:

1. Build the BCI transformer jar (`bci-classfile/`, JDK 24+).
2. Build the native agent with CMake (`agent/`).
3. Run the collector (`collector/`, Python 3.10+).
4. Launch `test-apps/TestException` with the agent attached.

## Submitting changes

1. Fork the repo and create a topic branch off `main`.
2. Make your change with a clear, focused commit history.
3. Add or update tests where applicable, and make sure existing checks pass.
4. Update docs (`README.md`, config reference) if you changed behavior or config.
5. Open a pull request describing **what** changed and **why**, and which
   component(s) it touches.

## Reporting bugs

Open a GitHub issue with: the component, your OS + JDK + Python versions, the
agent options used, steps to reproduce, and expected vs. actual behavior.

## Security issues

Do **not** file public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers the project.
