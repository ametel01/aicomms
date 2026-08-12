# Keep causal Messages in one Conversation

Every `agents.send` or `agents.ask` call made while Handling a Message inherits that Message's Conversation, and Agents cannot supply a Conversation identifier or reset its limits; only a call from the initial Objective turn starts a new Conversation. Keeping the causal chain inside one budget prevents Agents from escaping loop and deadline controls by nesting new Conversations.
