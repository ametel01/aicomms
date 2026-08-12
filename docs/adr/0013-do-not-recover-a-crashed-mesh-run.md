# Do not recover a crashed Mesh Run

When startup finds a previous Mesh Run with nonterminal records, the Supervisor will mark that run and its open Conversations failed with reason `supervisor_lost`, preserve the Transcript, and create new threads and Agent IDs. It will not resume or reinject old Messages in the first prototype because the at-most-once delivery guarantee cannot safely distinguish previously accepted work from work that still needs execution after a crash.
