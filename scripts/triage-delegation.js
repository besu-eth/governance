#!/usr/bin/env node
/**
 * triage-delegation.js
 *
 * Scans the Besu Triage project (besu-eth org, project #TRIAGE_PROJECT_NUMBER) for
 * issues whose Status is "Triage" but that have also been added to at least one other
 * project.  Those issues are considered "delegated" and their Status is updated to
 * DELEGATED_STATUS so they no longer appear in the intake-queue filter
 * (status:Triage is:open).  If the DELEGATED_STATUS option does not exist in the
 * project the item is removed from the Triage project entirely instead.
 *
 * Two execution modes are supported:
 *
 *   Full scan (default / scheduled)
 *     Iterates every item in the Triage project with Status = Triage and checks
 *     each one for membership in other projects.
 *
 *   Targeted scan (projects_v2_item event)
 *     Only inspects the single issue that was added to a project, identified via
 *     the GitHub Actions event payload at GITHUB_EVENT_PATH.  This makes the
 *     event-driven path cheap even for busy orgs.
 *
 * Required environment variable:
 *   GITHUB_TOKEN            PAT (classic) with scopes:  read:org, project
 *                           — or — fine-grained PAT with:
 *                             Organisation permissions  → Projects: Read & write
 *
 * Optional environment variables (all have sensible defaults):
 *   ORG_LOGIN               GitHub organisation login   (default: besu-eth)
 *   TRIAGE_PROJECT_NUMBER   Project number for intake   (default: 3)
 *   TRIAGE_STATUS           Name of the intake status   (default: Triage)
 *   DELEGATED_STATUS        Name of the delegated status (default: Delegated)
 *   DRY_RUN                 Set to "true" to log without making changes
 *
 * Note: status option names (TRIAGE_STATUS, DELEGATED_STATUS) are matched
 * case-insensitively against the project's Status field options.
 */

'use strict';

const fs = require('fs');

const ORG_LOGIN              = process.env.ORG_LOGIN              || 'besu-eth';
const TRIAGE_PROJECT_NUMBER  = parseInt(process.env.TRIAGE_PROJECT_NUMBER || '3', 10);
const TRIAGE_STATUS          = process.env.TRIAGE_STATUS          || 'Triage';
const DELEGATED_STATUS       = process.env.DELEGATED_STATUS       || 'Delegated';
const DRY_RUN                = process.env.DRY_RUN                === 'true';
const GITHUB_TOKEN           = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

async function graphql(query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const body = await response.json();
  if (body.errors && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Project metadata
// ---------------------------------------------------------------------------

async function getTriageProject() {
  const data = await graphql(
    `query($org: String!, $number: Int!) {
      organization(login: $org) {
        projectV2(number: $number) {
          id
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }`,
    { org: ORG_LOGIN, number: TRIAGE_PROJECT_NUMBER },
  );

  return data.organization.projectV2;
}

// ---------------------------------------------------------------------------
// Fetch all Triage-status items (paginated)
// ---------------------------------------------------------------------------

async function getTriageItems(projectId, statusFieldId, triageOptionId) {
  const items = [];
  let cursor = null;

  do {
    const data = await graphql(
      `query($projectId: ID!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                content {
                  __typename
                  ... on Issue {
                    id
                    number
                    title
                    url
                    repository { nameWithOwner }
                  }
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      optionId
                      field {
                        ... on ProjectV2SingleSelectField { id name }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { projectId, after: cursor },
    );

    const page = data.node.items;

    for (const item of page.nodes) {
      // Only process issues (not PRs or other content types)
      if (!item.content || item.content.__typename !== 'Issue') continue;

      const statusValue = item.fieldValues.nodes.find(
        fv => fv.field && fv.field.id === statusFieldId,
      );

      if (statusValue && statusValue.optionId === triageOptionId) {
        items.push(item);
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return items;
}

// ---------------------------------------------------------------------------
// Look up a single item in the Triage project by issue node ID
// ---------------------------------------------------------------------------

async function getTriageItemForIssue(projectId, issueNodeId, statusFieldId, triageOptionId) {
  // We cannot filter project items by content node ID via GraphQL directly, so
  // we query the issue's projectItems and find the one for our project.
  const data = await graphql(
    `query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          number
          title
          url
          repository { nameWithOwner }
          projectItems(first: 50) {
            nodes {
              id
              project { id number title }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    optionId
                    field {
                      ... on ProjectV2SingleSelectField { id name }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { issueId: issueNodeId },
  );

  if (!data.node) return null;

  const issue = data.node;
  const triageProjectItem = issue.projectItems.nodes.find(
    pi => pi.project.id === projectId,
  );

  if (!triageProjectItem) return null;

  const statusValue = triageProjectItem.fieldValues.nodes.find(
    fv => fv.field && fv.field.id === statusFieldId,
  );

  if (!statusValue || statusValue.optionId !== triageOptionId) return null;

  // Return in the same shape as getTriageItems()
  return {
    id: triageProjectItem.id,
    content: {
      __typename: 'Issue',
      id: issueNodeId,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      repository: issue.repository,
    },
    // Also attach full projectItems for the delegation check below
    _allProjectItems: issue.projectItems.nodes,
  };
}

// ---------------------------------------------------------------------------
// Check whether an issue belongs to other projects
// ---------------------------------------------------------------------------

async function getIssueOtherProjects(issueNodeId, triageProjectId, cachedProjectItems) {
  let projectItems;

  if (cachedProjectItems) {
    projectItems = cachedProjectItems;
  } else {
    const data = await graphql(
      `query($issueId: ID!) {
        node(id: $issueId) {
          ... on Issue {
            projectItems(first: 50) {
              nodes {
                id
                project { id number title }
              }
            }
          }
        }
      }`,
      { issueId: issueNodeId },
    );

    if (!data.node) return [];

    projectItems = data.node.projectItems.nodes;
  }

  return projectItems.filter(pi => pi.project.id !== triageProjectId);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function updateItemStatus(projectId, itemId, fieldId, optionId) {
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: ID!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId, fieldId, optionId },
  );
}

async function removeItemFromProject(projectId, itemId) {
  await graphql(
    `mutation($projectId: ID!, $itemId: ID!) {
      deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
        deletedItemId
      }
    }`,
    { projectId, itemId },
  );
}

// ---------------------------------------------------------------------------
// Core delegation logic for a single item
// ---------------------------------------------------------------------------

async function processDelegation(item, project, statusField, delegatedOption) {
  const issue = item.content;
  const otherProjects = await getIssueOtherProjects(
    issue.id,
    project.id,
    item._allProjectItems || null,
  );

  if (otherProjects.length === 0) return false;

  const otherNames = otherProjects
    .map(p => `"${p.project.title}" (#${p.project.number})`)
    .join(', ');

  console.log(
    `  Issue #${issue.number} in ${issue.repository.nameWithOwner} ` +
    `is also in: ${otherNames}`,
  );

  if (DRY_RUN) {
    if (delegatedOption) {
      console.log(`    → [DRY RUN] Would set Status = "${DELEGATED_STATUS}"`);
    } else {
      console.log(`    → [DRY RUN] Would remove from Triage project`);
    }
    return true;
  }

  if (delegatedOption) {
    await updateItemStatus(project.id, item.id, statusField.id, delegatedOption.id);
    console.log(`    → Status updated to "${DELEGATED_STATUS}"`);
  } else {
    await removeItemFromProject(project.id, item.id);
    console.log('    → Removed from Triage project');
  }

  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `Triage delegation check — org: ${ORG_LOGIN}, ` +
    `project: #${TRIAGE_PROJECT_NUMBER}` +
    (DRY_RUN ? ' [DRY RUN]' : ''),
  );

  // Fetch project metadata
  const project = await getTriageProject();
  if (!project) {
    console.error(
      `Project #${TRIAGE_PROJECT_NUMBER} not found in org "${ORG_LOGIN}". ` +
      'Check TRIAGE_PROJECT_NUMBER and that the token has project read access.',
    );
    process.exit(1);
  }
  console.log(`Project: "${project.title}" (${project.id})`);

  const statusField = project.fields.nodes.find(
    f => f.name && f.name.toLowerCase() === 'status',
  );
  if (!statusField) {
    console.error(
      'No "Status" single-select field found in the project. ' +
      'Create one before running this automation.',
    );
    process.exit(1);
  }

  const triageOption = statusField.options.find(
    o => o.name.toLowerCase() === TRIAGE_STATUS.toLowerCase(),
  );
  if (!triageOption) {
    console.error(
      `No "${TRIAGE_STATUS}" option in the Status field. ` +
      'Set TRIAGE_STATUS to the correct option name.',
    );
    process.exit(1);
  }

  const delegatedOption = statusField.options.find(
    o => o.name.toLowerCase() === DELEGATED_STATUS.toLowerCase(),
  ) || null;

  if (!delegatedOption) {
    console.warn(
      `"${DELEGATED_STATUS}" option not found in Status field — ` +
      'delegated items will be removed from the project instead. ' +
      `Add a "${DELEGATED_STATUS}" option to keep a delegation history.`,
    );
  }

  // Determine which items to inspect
  const eventName  = process.env.GITHUB_EVENT_NAME  || '';
  const eventPath  = process.env.GITHUB_EVENT_PATH  || '';
  let delegatedCount = 0;

  if (eventName === 'projects_v2_item' && eventPath) {
    // ------------------------------------------------------------------
    // Targeted path: only check the issue from the event payload
    // ------------------------------------------------------------------
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const eventItem = event.projects_v2_item;

    // Skip if the event concerns the Triage project itself (item was added *to* it)
    if (eventItem.project_node_id === project.id) {
      console.log('Event is for the Triage project itself — nothing to do.');
      return;
    }

    const contentNodeId = eventItem.content_node_id;
    if (!contentNodeId) {
      console.log('Event item has no content_node_id (draft issue?) — skipping.');
      return;
    }

    console.log(`Targeted check for issue node ${contentNodeId}`);
    const item = await getTriageItemForIssue(
      project.id,
      contentNodeId,
      statusField.id,
      triageOption.id,
    );

    if (!item) {
      console.log('Issue is not in the Triage project with Status = Triage — nothing to do.');
      return;
    }

    const wasDelegated = await processDelegation(item, project, statusField, delegatedOption);
    if (wasDelegated) delegatedCount++;
  } else {
    // ------------------------------------------------------------------
    // Full scan path: check every Triage-status item in the project
    // ------------------------------------------------------------------
    console.log(`Full scan: fetching items with Status = "${TRIAGE_STATUS}"…`);
    const triageItems = await getTriageItems(project.id, statusField.id, triageOption.id);
    console.log(`Found ${triageItems.length} item(s) with Status = "${TRIAGE_STATUS}"`);

    for (const item of triageItems) {
      const wasDelegated = await processDelegation(item, project, statusField, delegatedOption);
      if (wasDelegated) delegatedCount++;
    }
  }

  console.log(`Done — ${delegatedCount} item(s) delegated.`);
}

main().catch(err => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
