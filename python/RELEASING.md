# First PyPI release

This is a useful alpha, not an empty name reservation: it evaluates Sprig 0.1
expressions, hashes/verifies source, and loads source from the phase-0 store.
No workflow uploads on a push or merge. Nothing here claims that a PyPI project
already exists. A pending publisher does **not** reserve the name.

## One-time owner setup

1. Sign in to your PyPI account, verify its email and enable two-factor
   authentication. Use an account you intend to maintain.
2. Before public release, choose the license for this Python package. There is
   currently no repository license to inherit; this change deliberately does not
   assign one. Add the agreed license text and package metadata, then rebuild.
3. Add a pending publisher at <https://pypi.org/manage/account/publishing/>:

   | Field | Value |
   | --- | --- |
   | PyPI project name | `sprigrun` |
   | GitHub owner | `nickjhay` |
   | Repository | `sprigrun` |
   | Workflow filename | `publish-python.yml` |
   | Environment | `pypi` |

4. Create the GitHub environment `pypi` for `nickjhay/sprigrun`; restrict it to
   the `main` branch and, where available, require your release approval.
5. Review the candidate README, version and distributions. From Actions, manually
   run **Publish Python package** on `main` to authorize that release. There is no
   API token to add to the repository. The publishing job alone gets OIDC access.

The initial candidate is `0.1.0a1`. The workflow tests and builds from the selected
main commit, checks metadata, installs the built wheel in a fresh environment,
and runs its tests including the bundled loopback test server, then uploads that
same artifact. No access to the hosting repository is needed. The first successful
upload creates the project.
Do not publish a throwaway file just to claim the name. PyPI release filenames
cannot be reused; use a new version for corrections. Keep CLI version metadata
and `pyproject.toml` synchronized (the installed-wheel smoke check verifies this).

The license guard in the release workflow intentionally fails until the license
decision has been recorded in `pyproject.toml`. Normal CI and local builds work
before that decision. After publishing, verify the project description and
install the exact released version into a fresh environment to smoke-test it.

## References

- [PyPI name policy / PEP 541](https://peps.python.org/pep-0541/)
- [Choosing a project name](https://docs.pypi.org/project-management/choosing-a-name/)
- [Creating a project through a pending publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
- [Publishing to PyPI](https://docs.pypi.org/publishing/publishing-to-pypi/)
