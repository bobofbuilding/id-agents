// SPDX-License-Identifier: MIT
/**
 * Simple test of Claude Agent SDK
 * Non-interactive test to verify the SDK is working
 */

import 'dotenv/config';
import { runClaudeAgent, CLAUDE_MODELS, modelDisplayName } from './claude-agent.js';

async function main() {
  console.log('🤖 Testing Claude Agent SDK...\n');
  
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const model = process.env.CLAUDE_MODEL || CLAUDE_MODELS.HAIKU;
  const modelName = modelDisplayName(model);

  console.log(`Using model: ${modelName}\n`);
  console.log('Prompt: "List the files in the src/ directory"\n');
  console.log('🤖 Claude:\n');

  try {
    for await (const message of runClaudeAgent(
      "List the files in the src/ directory",
      { allowedTools: ['Bash', 'Glob'] }
    )) {
      // Show thinking
      if (message.type === 'thinking' && message.content) {
        console.log(`💭 ${message.content}`);
      }
      
      // Show tool use
      if (message.type === 'tool_use') {
        const toolName = (message as any).tool_name || 'unknown';
        console.log(`🔧 Using tool: ${toolName}`);
      }
      
      // Show final result
      if ('result' in message && message.result) {
        console.log(`\n✅ Result:\n${message.result}\n`);
      }
    }
    
    console.log('✅ Test completed successfully!');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
