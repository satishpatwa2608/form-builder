# Made once, used everywhere: lists, emails, fragments, workflows

Four libraries hold what several forms have in common. Each has its own page in
the menu, where administrators change it and everyone can read it.

| Library | What it holds | How a form uses it | When a change reaches the forms |
|---|---|---|---|
| **Lists** | Choices for dropdowns: branches, departments, products | On a dropdown, *Options come from → A shared list* | At once |
| **Email templates** | An email's subject and message | *Email requester* on a record; *Start from a saved email* in a workflow's email step | Its words are copied when it is used |
| **Fragments** | A section of fields: an address, bank details | From the builder's palette, under Fragments | At the form's next publish |
| **Workflows** | A whole process: statuses, buttons, service times, steps | In a form's Workflow, *use a shared workflow* | At the form's next publish |

## Lists (master data)

A list is made once: name it, type its items one to a row or paste many at
once. Every item gets a value that never changes, so renaming an item does not
orphan answers already given. An item taken out is retired: no longer offered,
still readable on old responses.

**A list can depend on another.** Branches depend on Cities; each branch says
which city it belongs to. On a form, the Branch dropdown is told which field
holds the city, and offers only that city's branches. The server checks the
choice as well, so a branch of another city is refused.

A list in use by a form, or one another list depends on, cannot be deleted.

## Who a workflow step gives the record to

The Assign step of a workflow chooses the person in one of five ways:

| Way | What it does |
|---|---|
| A person I choose now | Always the same person |
| It depends on an answer | Each choice of a dropdown has its person; any other answer goes to one named for the rest |
| The next person in a team, in turn | Round and round the people named |
| The manager of whoever has it | Moves it up one level |
| The person an answer or an earlier step names | The member whose email an email field holds, or that a Custom API step returned |

The last is how your own code decides: a Custom API step looks the owner up in
your system and returns their email, and the Assign step after it gives them the
record. If nobody is found the step fails and says so on the record, rather than
leaving it with no one.

## How this compares with AEM Forms

| AEM Forms | Here |
|---|---|
| Form data model: lists and services from a data source | Lists for your own master data; Connectors for your systems (databases, REST, OData, Salesforce, spreadsheets) |
| Form fragments | Fragments |
| Workflow model reused across forms | Shared workflows |
| Assign task step | Statuses, buttons, approvals and the Work inbox |
| Dynamic participant step | The Assign step's "depends on an answer", "in turn", "manager" and "an earlier step names" |
| Process step (custom code) | Custom API step, run by your extension |
| Send email step, with templates | Email step, with saved emails |
| Sign document step | Sign step |
| Generate document of record | A PDF of each response, attached to emails or sent for signature |
| Invoke form data model service | Connector steps (send to, look up in, your systems) |
| OR split, goto | A condition on each step |
| Variables | What earlier steps returned: `{{$steps.<step>.<value>}}` |
| Inbox and workspace | Work inbox, as a modal with tabs |

Still missing against AEM: several branches of a workflow running side by side,
a visual drawing of the workflow, themes edited on screen, interactive
communications (letters and statements), and encryption of chosen fields (see
`docs/payments-and-codes.md` for what is protected today).
