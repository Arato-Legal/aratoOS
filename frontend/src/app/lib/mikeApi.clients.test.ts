import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addClientContact,
  browseDriveFolders,
  createClient,
  createMatterDriveFolder,
  getClientFiles,
  setClientDriveFolder,
  setMatterSharing,
  createCrmSyncEndpoint,
  deleteCrmSyncEndpoint,
  deleteClient,
  deleteClientContact,
  getClient,
  listClientChats,
  getIntegrationSettings,
  updateIntegrationSettings,
  getDriveSyncStatus,
  getMatterWorkspace,
  getMatterDashboard,
  listClients,
  listCrmSyncEndpoints,
  listCrmSyncEvents,
  openDriveFileForEditing,
  pullDocumentFromDrive,
  saveDocumentToDrive,
  setMatterClient,
  setMatterDriveFolder,
  rotateCrmSyncSecret,
  updateClient,
  updateCrmSyncEndpoint,
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
  fetchMock.mockImplementation(async () => json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Clients API requests", () => {
  it.each([
    { name: "list", call: () => listClients(), url: "/api/clients", method: "GET" },
    {
      name: "list with filters",
      call: () => listClients({ workspace: "org/a", status: "lead", q: "ac me" }),
      url: "/api/clients?workspace=org%2Fa&status=lead&q=ac+me",
      method: "GET",
    },
    {
      name: "create",
      call: () => createClient({ name: "Acme", status: "lead" }),
      url: "/api/clients",
      method: "POST",
      body: { name: "Acme", status: "lead" },
    },
    {
      name: "create in a workspace",
      call: () => createClient({ name: "Acme" }, "org/a"),
      url: "/api/clients?workspace=org%2Fa",
      method: "POST",
      body: { name: "Acme" },
    },
    { name: "get", call: () => getClient("c1"), url: "/api/clients/c1", method: "GET" },
    {
      name: "update",
      call: () => updateClient("c1", { email: null }),
      url: "/api/clients/c1",
      method: "PATCH",
      body: { email: null },
    },
    { name: "delete", call: () => deleteClient("c1"), url: "/api/clients/c1", method: "DELETE" },
    {
      name: "add contact",
      call: () => addClientContact("c1", { name: "Jo", role: "CFO" }),
      url: "/api/clients/c1/contacts",
      method: "POST",
      body: { name: "Jo", role: "CFO" },
    },
    {
      name: "delete contact",
      call: () => deleteClientContact("c1", "k1"),
      url: "/api/clients/c1/contacts/k1",
      method: "DELETE",
    },
    {
      name: "matter dashboard",
      call: () => getMatterDashboard("p1"),
      url: "/api/clients/matters/p1",
      method: "GET",
    },
    {
      name: "attach a matter",
      call: () => setMatterClient("p1", "c1"),
      url: "/api/clients/matters/p1",
      method: "PUT",
      body: { client_id: "c1" },
    },
    {
      name: "detach a matter",
      call: () => setMatterClient("p1", null),
      url: "/api/clients/matters/p1",
      method: "PUT",
      body: { client_id: null },
    },
    {
      name: "matter workspace",
      call: () => getMatterWorkspace("p1"),
      url: "/api/clients/matters/p1/workspace",
      method: "GET",
    },
    {
      name: "link a Drive folder",
      call: () => setMatterDriveFolder("p1", "folder-1"),
      url: "/api/clients/matters/p1/drive-folder",
      method: "PUT",
      body: { folder_id: "folder-1" },
    },
    {
      name: "unlink the Drive folder",
      call: () => setMatterDriveFolder("p1", null),
      url: "/api/clients/matters/p1/drive-folder",
      method: "PUT",
      body: { folder_id: null },
    },
    {
      name: "browse Drive folders",
      call: () => browseDriveFolders(),
      url: "/api/clients/drive/folders",
      method: "GET",
    },
    {
      name: "browse a folder in a workspace",
      call: () => browseDriveFolders({ parent: "f/1", workspace: "personal" }),
      url: "/api/clients/drive/folders?parent=f%2F1&workspace=personal",
      method: "GET",
    },
    {
      name: "open a Drive file for editing",
      call: () => openDriveFileForEditing("p1", "f/1"),
      url: "/api/clients/matters/p1/drive-files/f%2F1/edit",
      method: "POST",
    },
    {
      name: "Drive sync status",
      call: () => getDriveSyncStatus("d1"),
      url: "/api/clients/documents/d1/drive",
      method: "GET",
    },
    {
      name: "save to Drive",
      call: () => saveDocumentToDrive("d1"),
      url: "/api/clients/documents/d1/drive/save",
      method: "POST",
      body: { overwrite: false },
    },
    {
      name: "save to Drive, overwriting",
      call: () => saveDocumentToDrive("d1", { overwrite: true }),
      url: "/api/clients/documents/d1/drive/save",
      method: "POST",
      body: { overwrite: true },
    },
    {
      name: "update from Drive",
      call: () => pullDocumentFromDrive("d1"),
      url: "/api/clients/documents/d1/drive/pull",
      method: "POST",
    },
    {
      name: "list CRM sync endpoints",
      call: () => listCrmSyncEndpoints("org/a"),
      url: "/api/crm-sync/endpoints?workspace=org%2Fa",
      method: "GET",
    },
    {
      name: "list CRM sync endpoints without a workspace",
      call: () => listCrmSyncEndpoints(),
      url: "/api/crm-sync/endpoints",
      method: "GET",
    },
    {
      name: "create a CRM sync endpoint",
      call: () => createCrmSyncEndpoint({ name: "Hubflo", provider: "hubflo" }, "personal"),
      url: "/api/crm-sync/endpoints?workspace=personal",
      method: "POST",
      body: { name: "Hubflo", provider: "hubflo" },
    },
    {
      name: "update a CRM sync endpoint",
      call: () => updateCrmSyncEndpoint("e1", { enabled: false }),
      url: "/api/crm-sync/endpoints/e1",
      method: "PATCH",
      body: { enabled: false },
    },
    {
      name: "replace a CRM sync secret",
      call: () => rotateCrmSyncSecret("e1"),
      url: "/api/crm-sync/endpoints/e1/rotate-secret",
      method: "POST",
    },
    {
      name: "delete a CRM sync endpoint",
      call: () => deleteCrmSyncEndpoint("e1"),
      url: "/api/crm-sync/endpoints/e1",
      method: "DELETE",
    },
    {
      name: "list CRM sync events",
      call: () => listCrmSyncEvents("e1"),
      url: "/api/crm-sync/endpoints/e1/events",
      method: "GET",
    },
    {
      name: "create matter Drive folder",
      call: () => createMatterDriveFolder("p1"),
      url: "/api/clients/matters/p1/drive-folder/create",
      method: "POST",
    },
    {
      name: "set client Drive folder",
      call: () => setClientDriveFolder("c1", "f1"),
      url: "/api/clients/c1/drive-folder",
      method: "PUT",
      body: { folder_id: "f1" },
    },
    {
      name: "set matter sharing",
      call: () => setMatterSharing("p1", false),
      url: "/api/clients/matters/p1/sharing",
      method: "PUT",
      body: { share_with_client: false },
    },
    {
      name: "get client files",
      call: () => getClientFiles("p1"),
      url: "/api/clients/matters/p1/client-files",
      method: "GET",
    },
    {
      name: "get integration settings",
      call: () => getIntegrationSettings("org/a"),
      url: "/api/clients/integrations?workspace=org%2Fa",
      method: "GET",
    },
    {
      name: "update integration settings",
      call: () => updateIntegrationSettings("org/a", { drive_shared: true }),
      url: "/api/clients/integrations?workspace=org%2Fa",
      method: "PUT",
      body: { drive_shared: true },
    },
    {
      name: "list client chats",
      call: () => listClientChats("c1"),
      url: "/api/clients/c1/chats",
      method: "GET",
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
