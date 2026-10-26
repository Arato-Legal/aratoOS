// Create documents and versions from bytes that arrive outside an upload
// session (a file pulled from Google Drive, for example). Trusted persistence
// operations like createDocumentVersion: the caller authorizes the project
// (or document) first. Only .docx is accepted here, and no PDF rendition is
// made; the editor reads the .docx itself, as it does after an autosave.

import crypto from "node:crypto";
import { contentSha256 } from "../../lib/documentVersions";
import { contentTypeForDocumentType } from "../../lib/documentTypes";
import { deleteFileBestEffort, storageKey, uploadFile, versionStorageKey } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { createDocumentVersion } from "./documents.lifecycle";

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function docxFilename(name: string): string {
  const cleaned = name.replace(/[\\/\0]/g, "_").trim() || "Document";
  return /\.docx$/i.test(cleaned) ? cleaned : `${cleaned}.docx`;
}

export type ImportedDocument = {
  documentId: string;
  versionId: string;
  filename: string;
  sha256: string;
};

export async function createDocumentFromDocxBytes(
  db: Db,
  args: { userId: string; projectId: string; name: string; bytes: Buffer },
): Promise<ServiceResult<ImportedDocument>> {
  if (args.bytes.byteLength === 0) return failure("validation", "The file is empty.");
  const filename = docxFilename(args.name);
  const { data: doc, error: docError } = await db
    .from("documents")
    .insert({ project_id: args.projectId, user_id: args.userId, status: "ready" })
    .select("id")
    .single();
  if (docError || !doc) return internalFailure(docError);
  const documentId = doc.id as string;

  const key = storageKey(args.userId, documentId, filename);
  const sha256 = contentSha256(args.bytes);
  try {
    await uploadFile(key, toArrayBuffer(args.bytes), contentTypeForDocumentType("docx"));
  } catch (error) {
    await db.from("documents").delete().eq("id", documentId);
    return internalFailure(error);
  }
  const { data: version, error: versionError } = await createDocumentVersion(db, {
    document_id: documentId,
    storage_path: key,
    source: "upload",
    filename,
    file_type: "docx",
    size_bytes: args.bytes.byteLength,
    content_sha256: sha256,
  });
  if (versionError || !version) {
    await db.from("documents").delete().eq("id", documentId);
    await deleteFileBestEffort(key, "drive-import-failed");
    return internalFailure(versionError);
  }
  return ok({ documentId, versionId: version.id, filename, sha256 });
}

// A new active version of an existing document, from .docx bytes.
export async function addDocxVersionToDocument(
  db: Db,
  args: { userId: string; documentId: string; name: string; bytes: Buffer },
): Promise<ServiceResult<ImportedDocument>> {
  if (args.bytes.byteLength === 0) return failure("validation", "The file is empty.");
  const filename = docxFilename(args.name);
  const slug = crypto.randomUUID().replace(/-/g, "");
  const key = versionStorageKey(args.userId, args.documentId, slug, filename);
  const sha256 = contentSha256(args.bytes);
  try {
    await uploadFile(key, toArrayBuffer(args.bytes), contentTypeForDocumentType("docx"));
  } catch (error) {
    return internalFailure(error);
  }
  const { data: version, error } = await createDocumentVersion(db, {
    document_id: args.documentId,
    storage_path: key,
    source: "user_upload",
    filename,
    file_type: "docx",
    size_bytes: args.bytes.byteLength,
    content_sha256: sha256,
  });
  if (error || !version) {
    await deleteFileBestEffort(key, "drive-import-failed");
    return internalFailure(error);
  }
  return ok({ documentId: args.documentId, versionId: version.id, filename, sha256 });
}
