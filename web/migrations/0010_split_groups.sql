-- Shared expenses at their own split: a statement summary can now bring, besides its
-- usual shared part, one more shared expense per split (say 70/30). Those are tied to
-- the upload they came with, so taking an upload out takes all of its expenses out.
-- upload_of is the upload's batch id, or its main shared expense's id when it has no batch.
ALTER TABLE entries ADD COLUMN upload_of TEXT;
CREATE INDEX entries_upload_of ON entries (upload_of);
