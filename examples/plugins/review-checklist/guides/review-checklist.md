# Review checklist

Summary: Put a checklist the user ticks off in the chat: the files you changed, or any steps.

When you finish a change the user should look over, or a list of steps they
have to do themselves, place the checklist instead of writing the list out:

    ```bivy
    {"type":"widget","widget":"review-checklist","data":{"title":"Before merge"}}
    ```

Without `items` it lists the files with uncommitted changes in the workspace.
With `"items": ["Run the migration", "Rotate the key"]` it lists those. When the
user presses Send, you get "Checklist: done …; left …." as their message. The
`changed_files` tool gives you the same file list: `bivy tools run changed_files`.
