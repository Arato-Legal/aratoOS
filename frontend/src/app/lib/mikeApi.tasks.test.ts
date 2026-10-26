import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectTask,
  deleteProjectTask,
  getNotificationPreferences,
  listNotifications,
  listProjectTasks,
  markNotificationsRead,
  setDocumentVersionReview,
  setNotificationPreferences,
  updateProjectTask,
} from "./mikeApi";

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json({ tasks: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Tasks, notifications and review API requests", () => {
  it.each([
    {
      name: "list notifications",
      call: () => listNotifications(),
      url: "/api/user/notifications",
      method: "GET",
    },
    {
      name: "list unread notifications with a limit",
      call: () => listNotifications({ unreadOnly: true, limit: 5 }),
      url: "/api/user/notifications?unread=1&limit=5",
      method: "GET",
    },
    {
      name: "mark some notifications read",
      call: () => markNotificationsRead({ ids: ["n1", "n2"] }),
      url: "/api/user/notifications/read",
      method: "POST",
      body: { ids: ["n1", "n2"] },
    },
    {
      name: "mark all notifications read",
      call: () => markNotificationsRead({ all: true }),
      url: "/api/user/notifications/read",
      method: "POST",
      body: { all: true },
    },
    {
      name: "get notification preferences",
      call: () => getNotificationPreferences(),
      url: "/api/user/notifications/preferences",
      method: "GET",
    },
    {
      name: "set notification preferences",
      call: () => setNotificationPreferences("daily"),
      url: "/api/user/notifications/preferences",
      method: "PUT",
      body: { email_mode: "daily" },
    },
    {
      name: "list open tasks",
      call: () => listProjectTasks("p1"),
      url: "/api/projects/p1/tasks?status=open",
      method: "GET",
    },
    {
      name: "list all tasks",
      call: () => listProjectTasks("p1", "all"),
      url: "/api/projects/p1/tasks?status=all",
      method: "GET",
    },
    {
      name: "create a task",
      call: () => createProjectTask("p1", { title: "File by Friday", due_on: "2026-11-06" }),
      url: "/api/projects/p1/tasks",
      method: "POST",
      body: { title: "File by Friday", due_on: "2026-11-06" },
    },
    {
      name: "update a task",
      call: () => updateProjectTask("p1", "t1", { status: "done" }),
      url: "/api/projects/p1/tasks/t1",
      method: "PATCH",
      body: { status: "done" },
    },
    {
      name: "delete a task",
      call: () => deleteProjectTask("p1", "t1"),
      url: "/api/projects/p1/tasks/t1",
      method: "DELETE",
    },
    {
      name: "set a version's review state",
      call: () => setDocumentVersionReview("d1", "v1", "in_review"),
      url: "/api/single-documents/d1/versions/v1/review",
      method: "PATCH",
      body: { state: "in_review" },
    },
    {
      name: "set a version's review state with a note",
      call: () => setDocumentVersionReview("d1", "v1", "approved", "Signed off"),
      url: "/api/single-documents/d1/versions/v1/review",
      method: "PATCH",
      body: { state: "approved", note: "Signed off" },
    },
  ])("$name", async ({ call, url, method, body }) => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe(url);
    expect(init.method ?? "GET").toBe(method);
    if (body === undefined) expect(init.body).toBeUndefined();
    else expect(JSON.parse(init.body)).toEqual(body);
  });
});
