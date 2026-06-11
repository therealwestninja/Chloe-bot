## Full List of Commands


### [User]

`!chloe help` — Show available commands and usage information.

`!chloe status` — Show Chloe's current status and operating state.

`!chloe recap` — Generate a summary/recap of recent channel activity.

`!chloe persona` — Show the currently active persona note.

`!chloe persona clear` — Clear the active persona note.

`!chloe forget me` — Delete Chloe's stored memory/history about you while preserving moderation records.

Short aliases:

`!c help`

`!c status`

`!c recap`

`!c persona`

`!c persona clear`

`!c forget me`

### [Moderator]

`!chloe ignore @user` — Add a user to the ignore list.

`!chloe unignore @user` — Remove a user from the ignore list.

`!chloe timeout @user <duration>` — Temporarily ignore a user for a specified time.

`!chloe softban @user` — Permanently ignore a user without banning them from Discord.

`!chloe unsoftban @user` — Remove a soft-ban.

`!chloe warn @user` — Add a warning/strike to a user.

`!chloe warn @user <reason>` — Add a warning with a reason.

`!chloe warns @user` — Show a user's warning count.

`!chloe note @user <text>` — Attach a moderator note to a user.

`!chloe clear @user` — Clear Chloe's stored state, notes, and warnings for a user.

`!chloe lockdown` — Restrict interaction to moderators only.

`!chloe unlock` — End lockdown mode and restore normal operation.

`!chloe open` — Put Chloe into open/reply-to-everyone mode.

### Short aliases:

`!c ignore`

`!c unignore`

`!c timeout`

`!c softban`

`!c unsoftban`

`!c warn`

`!c warns`

`!c note`

`!c clear`

`!c lockdown`

`!c unlock`

`!c open`

### [Administrator / High-Privilege]

`!chloe permaban @user` — Permanently ban a user and purge Chloe's stored information about them. Requires confirmation.

Short alias:

`!c permaban @user`

### [Non-Command Interactions]

`@chloe-bot <message>` — Directly address Chloe.

`chloe, <message>` — Address Chloe by name.

`chloe <message>` — Name-triggered interaction.

`📌 react to a message` — Pin a message as the active personality/persona note (moderator feature).