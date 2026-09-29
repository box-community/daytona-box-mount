import {
  BoxClient,
  BoxDeveloperTokenAuth,
} from "box-node-sdk";

export function createBoxClient(token: string): BoxClient {
  const auth = new BoxDeveloperTokenAuth({ token });
  return new BoxClient({ auth });
}

async function findChildId(
  client: BoxClient,
  parentFolderId: string,
  name: string,
  type: "file" | "folder",
): Promise<string | undefined> {
  const items = await client.folders.getFolderItems(parentFolderId, {
    queryParams: {
      fields: ["id", "type", "name"],
      limit: 1000,
    },
  });
  const match = items.entries?.find(
    (entry) => entry.type === type && entry.name === name,
  );
  return match?.id;
}

async function childId(
  client: BoxClient,
  parentFolderId: string,
  name: string,
  type: "file" | "folder",
): Promise<string> {
  const id = await findChildId(client, parentFolderId, name, type);
  if (!id) {
    throw new Error(
      `Could not find ${type} "${name}" in Box folder ${parentFolderId}.`,
    );
  }
  return id;
}

export async function validateBoxAccess(
  token: string,
  folderId: string,
): Promise<{ user: string; folder: string }> {
  const client = createBoxClient(token);
  const [user, folder] = await Promise.all([
    client.users.getUserMe({ fields: ["id", "name"] }),
    client.folders.getFolderById(folderId, {
      queryParams: { fields: ["id", "name"] },
    }),
  ]);

  return {
    user: user.name ?? "current user",
    folder: `${folder.name ?? "Unnamed folder"} (${folder.id})`,
  };
}

export async function assignReviewTask(
  token: string,
  rootFolderId: string,
  reviewerUserId: string,
): Promise<void> {
  const client = createBoxClient(token);
  const reviewedFolderId = await childId(
    client,
    rootFolderId,
    "Reviewed",
    "folder",
  );

  let reviewFileId: string | undefined;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    reviewFileId = await findChildId(
      client,
      reviewedFolderId,
      "Acme-MSA-review.md",
      "file",
    );
    if (reviewFileId) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!reviewFileId) {
    throw new Error(
      "The generated review did not reach Box in time to assign a task.",
    );
  }

  const task = await client.tasks.createTask({
    item: { id: reviewFileId, type: "file" },
    action: "review",
    message: "Please review the AI-generated contract analysis.",
    completionRule: "all_assignees",
  });
  if (!task.id) {
    throw new Error("Box created the review task without returning an ID.");
  }

  try {
    await client.taskAssignments.createTaskAssignment({
      task: { id: task.id, type: "task" },
      assignTo: { id: reviewerUserId },
    });
  } catch (error) {
    await client.tasks.deleteTaskById(task.id).catch(() => undefined);
    throw error;
  }
}
