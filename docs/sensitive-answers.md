# Sensitive answers

Some answers should not sit in a database in plain text: an ID number, a bank
account, a date of birth. Mark the question **Sensitive** (the switch is in the
question's settings in the builder) and its answers are stored encrypted.

## What it does

- The answer is encrypted as the response is saved (AES-256-GCM, with a fresh
  random value each time, so two people giving the same answer do not get the
  same stored text).
- A copy of the database, a backup, or someone reading the collection directly
  sees only the encrypted text.
- Everything that reads a response through the product still sees the answer:
  the record, the PDF, emails written from the answers, exports, connectors
  and webhooks.
- Answers saved for later (a draft) are encrypted in the same way, and come
  back as they were typed when the person continues.
- The Work inbox leaves sensitive answers out of the one-line summary of each
  record.
- A repeating section that has a sensitive question in its rows is encrypted
  whole.

## What it does not do

- It does not hide the answer from people who may open the record or export
  responses. Who may do that is decided by roles and by the form's team.
- A sensitive answer cannot be searched or filtered on. The database cannot
  see it, so a search for it finds nothing.
- It applies to responses sent after the switch is turned on and the form is
  published. Responses already stored are not changed.
- Uploaded files are not covered by this switch; they are kept in file
  storage, which is encrypted as a whole.

## The key

Answers are sealed with the installation's `SECRET_KEY`. Keep it as you keep
the database password, and keep a copy somewhere safe: without that key the
sealed answers cannot be read by anyone, and the product shows them as empty.
Changing the key does not re-encrypt what is already stored.

## Everything else that is encrypted

| What | How |
|---|---|
| Traffic between browsers and the product | TLS |
| The server's disk and file storage | Encrypted by the hosting provider |
| Passwords of connectors, mail servers, payment and SMS services | Sealed with `SECRET_KEY`; never shown again |
| Sign-in passwords | Hashed (argon2id); nobody can read them back |
| Answers to questions marked Sensitive | Sealed with `SECRET_KEY`, per answer |
