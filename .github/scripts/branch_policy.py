"""Validate GitHub PR metadata without importing or running any PR code."""

import json
import os
import sys
from pathlib import Path


def check_event(event, repository):
    if not isinstance(event, dict) or not isinstance(repository, str) or not repository:
        raise ValueError("Missing repository identity")
    pull_request = event.get("pull_request")
    if not isinstance(pull_request, dict):
        raise ValueError("Expected a pull request event")
    base = pull_request.get("base")
    head = pull_request.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise ValueError("Missing pull request branches")
    base_repo = base.get("repo")
    head_repo = head.get("repo")
    if not isinstance(base_repo, dict) or base_repo.get("full_name") != repository:
        raise ValueError("Pull request targets another repository")
    if not isinstance(head_repo, dict) or not isinstance(head_repo.get("full_name"), str):
        raise ValueError("Missing source repository")
    if not isinstance(head.get("ref"), str) or not head["ref"]:
        raise ValueError("Missing source branch")
    if base.get("ref") == "main":
        if head["ref"] != "staging" or head_repo["full_name"] != repository:
            raise ValueError("Production releases must come from this repository's staging branch")
        return "Allowed: staging release into main"
    if base.get("ref") == "staging":
        return "Allowed: pull request into staging"
    raise ValueError("Pull request must target staging or main")


def main():
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        message = check_event(event, os.environ["GITHUB_REPOSITORY"])
    except (KeyError, OSError, ValueError, TypeError):
        print("Branch policy failed: target staging for feature work; release to main from this repository's staging branch.", file=sys.stderr)
        return 1
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
