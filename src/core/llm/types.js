/**
 * @typedef {{name:string, description:string, parameters:object}} Tool
 * @typedef {{type:'text', text:string, textSignature?:string}} TextBlock
 * @typedef {{type:'thinking', thinking:string, thinkingSignature?:string, providerItem?:object, redacted?:boolean}} ThinkingBlock
 * @typedef {{type:'toolCall', id:string, name:string, arguments:object, thoughtSignature?:string}} ToolCall
 * @typedef {TextBlock|ThinkingBlock|ToolCall} Block
 * @typedef {{input:number, output:number, cacheRead:number, cacheWrite:number, total:number, totalFromProvider?:boolean}} Cost
 * @typedef {{input:number, output:number, cacheRead:number, cacheWrite:number, cacheWrite1h?:number, totalTokens:number, cost:Cost}} Usage
 * @typedef {{role:'assistant', content:Block[], usage:Usage, stopReason:'stop'|'length'|'toolUse'|'error'|'aborted', errorMessage?:string, provider:string, model:string}} AssistantMessage
 * @typedef {{role:'user', content:string|TextBlock[]}} UserMessage
 * @typedef {{role:'toolResult', toolCallId:string, toolName:string, content:string|TextBlock[], isError?:boolean}} ToolResult
 * @typedef {{systemPrompt?:string, messages:(UserMessage|AssistantMessage|ToolResult)[], tools?:Tool[]}} Context
 * @typedef {{type:'api_key', key:string}|{type:'oauth', access:string, accountId?:string, projectId?:string, mode?:'direct'|'chatgpt'}} Auth
 * @typedef {{provider:string, model:string}} ModelRef
 * @typedef {{id:string, provider:string, api:string, baseUrl:string, contextWindow:number, maxTokens:number, reasoning:boolean, cost:object, thinkingLevelMap?:object}} Model
 * @typedef {{signal?:AbortSignal, auth?:Auth, maxTokens?:number, temperature?:number, reasoning?:'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max', timeoutMs?:number}} StreamOptions
 * @typedef {{type:string, contentIndex?:number, delta?:string, content?:string, partial?:AssistantMessage, message?:AssistantMessage, error?:AssistantMessage, toolCall?:ToolCall}} AssistantMessageEvent
 */
export {};
