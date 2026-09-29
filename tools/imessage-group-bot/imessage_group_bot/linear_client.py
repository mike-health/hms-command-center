"""Read-only Linear GraphQL client plus due-date updates (stdlib urllib)."""

from __future__ import print_function

import json
import urllib.error
import urllib.request


class LinearError(Exception):
    pass


ISSUES_QUERY = """
query PleasantHillIssues($filter: IssueFilter) {
  issues(first: 100, filter: $filter) {
    nodes {
      id
      identifier
      title
      description
      dueDate
      assignee { name displayName }
      labels { nodes { name } }
      state { name type }
    }
  }
}
"""

UPDATE_MUTATION = """
mutation SetDue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier dueDate title }
  }
}
"""


def title_in_scope(title, prefix):
    text = (title or "").lower()
    pre = (prefix or "").lower()
    if pre and text.startswith(pre):
        return True
    return "pleasant hill" in text


def _as_name_list(project_names):
    if not project_names:
        return []
    if isinstance(project_names, str):
        return [project_names]
    return [str(item).strip() for item in project_names if str(item).strip()]


def normalize_issue(node):
    if not node:
        return None
    assignee = node.get("assignee") or {}
    labels = []
    raw_labels = node.get("labels") or {}
    for item in raw_labels.get("nodes") or []:
        if item and item.get("name"):
            labels.append(item["name"])
    state = node.get("state") or {}
    return {
        "id": node.get("id"),
        "identifier": node.get("identifier") or "",
        "title": node.get("title") or "",
        "description": node.get("description") or "",
        "dueDate": node.get("dueDate"),
        "assignee_name": assignee.get("displayName") or assignee.get("name") or "",
        "labels": labels,
        "state_name": state.get("name") or "",
        "state_type": (state.get("type") or "").lower(),
    }


class LinearClient(object):
    def __init__(self, url, api_key, timeout=20, http_post=None):
        self.url = (url or "https://api.linear.app/graphql").rstrip("/")
        self.api_key = api_key or ""
        self.timeout = float(timeout or 20)
        self.http_post = http_post

    def graphql(self, query, variables=None):
        if not self.api_key:
            raise LinearError("Linear API key is empty")
        payload = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": self.api_key,
        }
        poster = self.http_post or _default_http_post
        raw = poster(self.url, payload, headers, self.timeout)
        try:
            body = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
        except Exception as exc:
            raise LinearError("invalid JSON from Linear: %s" % exc)
        if body.get("errors"):
            msg = body["errors"][0].get("message") if body["errors"] else "GraphQL error"
            raise LinearError(msg)
        return body.get("data") or {}

    def list_issues(self, team_key, project_names, title_prefix):
        names = _as_name_list(project_names)
        seen = {}
        for name in names or [None]:
            filt = {}
            if name:
                filt["project"] = {"name": {"eqIgnoreCase": name}}
            if team_key:
                filt["team"] = {"key": {"eq": team_key}}
            data = self.graphql(ISSUES_QUERY, {"filter": filt or None})
            nodes = ((data.get("issues") or {}).get("nodes")) or []
            for node in nodes:
                item = normalize_issue(node)
                if not item or not item["id"]:
                    continue
                if not title_in_scope(item["title"], title_prefix):
                    continue
                seen[item["id"]] = item
        return list(seen.values())

    def update_due_date(self, issue_id, due_date):
        data = self.graphql(
            UPDATE_MUTATION,
            {"id": issue_id, "input": {"dueDate": due_date}},
        )
        result = data.get("issueUpdate") or {}
        if not result.get("success"):
            raise LinearError("issueUpdate failed")
        return normalize_issue(result.get("issue") or {"id": issue_id, "dueDate": due_date})


class MockLinearClient(object):
    def __init__(self, issues=None):
        self.issues = [dict(item) for item in (issues or [])]
        self.update_calls = []
        self.list_calls = 0

    def list_issues(self, team_key, project_names, title_prefix):
        self.list_calls += 1
        names = [n.lower() for n in _as_name_list(project_names)]
        out = []
        for item in self.issues:
            title = item.get("title") or ""
            if not title_in_scope(title, title_prefix):
                continue
            proj = (item.get("project") or "").lower()
            if names and proj and proj not in names:
                continue
            out.append(dict(item))
        return out

    def update_due_date(self, issue_id, due_date):
        self.update_calls.append({"id": issue_id, "dueDate": due_date})
        for item in self.issues:
            if item.get("id") == issue_id:
                item["dueDate"] = due_date
                return dict(item)
        raise LinearError("issue not found: %s" % issue_id)


def _default_http_post(url, body, headers, timeout):
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.URLError as exc:
        raise LinearError("HTTP error: %s" % exc)
