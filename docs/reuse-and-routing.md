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

## When someone is away

On **Account & security**, the **Away** card takes three things: from which day
(empty means now), back on which day (empty means "until I say I'm back"), and
the colleague who gets your new work.

While you are away:

- A new record that would have been yours goes to that colleague. This holds for
  the form's own rule, an Assign step, and someone giving it to you by hand; the
  record's history says who it was meant for.
- An approval that would have been asked of you is asked of them.
- What you already hold stays with you. Nothing moves behind your back.
- If your colleague is away too, it goes on to theirs. If that comes back round
  to you, or you named nobody, the work comes to you as usual.

An administrator can see who is away on the Members page.

## A team's queue, and "Take it"

A form can name the team that works its records (form settings, "Who works
these records"): people by name, or whole departments. A record of that form
that nobody holds is the team's queue. Each member sees it under **My team's
queue** and presses **Take it** to make it theirs. If two press at once, one
gets it and the other is told who did.

Someone who manages people (set on the Members page) has **My team's work**:
what their people hold, which they can open and give to someone else.

To give a record to a colleague with a few words on why, use **Hand over with a
note** on the record. The note is in their notification and in the history.

## Ask a colleague

On a record, **Ask a colleague** takes a person and a question. The record
stays with whoever holds it. The colleague is told, can open the record and
read it, and has a box for their answer; they cannot move it, reassign it or
change it. When they answer, you are told, the answer is in the history, and
the record leaves their list.

## Several records at once

In the Work inbox, tick the items (or the box at the top for the whole page). A
bar appears with what can be done to all of them: give them to someone, set
their priority, take them (if nobody holds them), approve or reject (if they
are waiting for you). Each item still follows its own rules; afterwards you are
told how many were done and, for any that were not, which and why. Up to 50 at
a time.

## Approvals: who must answer, and what if nobody does

Wherever an approval is asked for (a step of a workflow, or a button that needs
approval) there are three choices:

| Choice | What it means |
|---|---|
| Who must approve | *Any one of them*: the first answer decides. *Every one of them*: it goes ahead when all have approved, and one rejection refuses it |
| Time to answer (hours) | Left empty, it waits for as long as it takes |
| If nobody answers in time | *Remind them*, *Ask their manager instead* (each person who has not answered gives way to their manager), or *Treat it as rejected* |

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
| Out of office | The Away card: from, back on, and who gets my new work |
| A task assigned to a group, claimed by one member | A team's queue and "Take it" |
| Manager view of a team's tasks | "My team's work" |
| Forward a task with a note | "Hand over with a note" |
| A task several people must all complete | "Every one of them" must approve |
| Task deadline and reminders | Time to answer, then remind, ask the manager, or refuse |

The full list of what AEM Forms has and where we stand is in [aem-gaps.md](aem-gaps.md).

Still missing against AEM: several branches of a workflow running side by side,
a visual drawing of the workflow, themes edited on screen, interactive
communications (letters and statements), and encryption of chosen fields (see
`docs/payments-and-codes.md` for what is protected today).
