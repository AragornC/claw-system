Issue 1: External feature (news/social) code apply failure
Root cause: validateFeatureExecutionCodeForApply() checks generatedCode.codeSource but only accepts explicit values (pipeline/template/deepseek/deepseek_repair). The new clarification flow sets codeSource="llm" which isn't in the allowlist. Also, the function still checks params.pythonIndicator as a fallback path that doesn't know about generatedCode.

Fix:

1.Accept codeSource="llm" and "llm_repair" in the validation
2.For external features that genuinely lack API access, instead of throwing an error, mark them as "needs_api_config" and allow saving with a warning
3.Add clear user guidance: "这个特征需要外部数据API，请在虾脑中配置相关API key"
Issue 2: Card interactions not in conversation context
Root cause: Only message text tracked via addMessage(). Card interactions (selections, confirmations, errors) not added to context.

Fix:

1.Track card events: when clarification card appears, when user selects options, when confirm succeeds/fails, when feature is applied/rejected
2.Add these as system messages in the conversation context
3.Model can then reference: "你刚才尝试创建了新闻情绪特征，但因为缺少API而失败"
Issue 3: Spurious "/model" reply from slow path
Root cause: When fast path doesn't detect intent (returns false), falls to slow path which calls runAgentTurn → OpenClaw CLI. OpenClaw's session may have stale state or the switchThunderSessionModel call emits /model commands into the session.

Fix:

1.Remove switchThunderSessionModel retry from the slow path
2.Clean up any /model command injection logic
3.Consider making the slow path also use LLM direct instead of OpenClaw CLI for general chat
Issue 4: History restore loses cards
Root cause: conversationContext only stores message text, not card metadata (clarification questions, confirm results, errors).

Fix:

1.Store card events as structured messages in conversation context
2.On restore, reconstruct card UI from stored card data
Issue 5: Extra text messages around card
Root cause: Fast path returns headline as reply, frontend runTurn() renders it as a text bubble via typewriter, then renders the card below it = two elements.

Fix:

1.When clarification card is present, replace the thinking element directly with the card (don't render a separate text bubble)
2.The card already has the headline inside it
Issue 6: E2E test coverage gaps
Fix: Add test cases for:

1.External data source features (news, social, prediction market)
2.Feature apply failure + error recovery
3.Card interaction context preservation
4.Slow path fallback behavior
5.Multiple scenario diversity
Execution Order
Issue 1+3 (blocking errors)
Issue 5 (UI cleanliness)
Issue 2+4 (context richness)
Issue 6 (E2E test suite)