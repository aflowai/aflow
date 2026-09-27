/** @param {import('estree').Node | null | undefined} node */
function isErrorLikeSecondArg(node) {
  if (!node) return false;
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return false;
    return true;
  }
  if (node.type === 'ConditionalExpression') return true;
  if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??'))
    return true;
  return false;
}

/** @param {import('estree').MemberExpression} memberExpr */
function isOrchestratorErrorCall(memberExpr) {
  if (memberExpr.type !== 'MemberExpression') return false;
  if (memberExpr.property.type !== 'Identifier' || memberExpr.property.name !== 'error')
    return false;

  let obj = memberExpr.object;

  // getOrchestratorLogger().error or .child(...).error
  if (obj.type === 'CallExpression') {
    const ce = obj;
    if (ce.callee.type === 'Identifier' && ce.callee.name === 'getOrchestratorLogger') return true;
    if (
      ce.callee.type === 'MemberExpression' &&
      ce.callee.property.type === 'Identifier' &&
      ce.callee.property.name === 'child' &&
      ce.callee.object.type === 'CallExpression' &&
      ce.callee.object.callee.type === 'Identifier' &&
      ce.callee.object.callee.name === 'getOrchestratorLogger'
    ) {
      return true;
    }
  }

  // const log = getOrchestratorLogger().child(...); log.error(...)
  if (obj.type === 'Identifier' && obj.name === 'log') return true;

  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const orchestratorLoggerErrorContext = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Orchestrator logger.error must include structured context (errorContext / errorContextFromUnknown)',
    },
    schema: [],
    messages: {
      needSecondArg:
        'Add structured context: logger.error(message, { ...errorContext(...) }) or logger.error(message, err, errorContextFromUnknown(err, { tenantId, runId, ... })). Prefer logOrchestratorError(message, err, { ... }) from orchestratorLogger.ts.',
      needThirdArgWhenError:
        'When the 2nd argument is an Error (or unknown err), pass errorContextFromUnknown(err, { ... }) as the 3rd argument. Prefer logOrchestratorError(message, err, { tenantId, runId, ... }).',
      logOrchestratorErrorNeedErr:
        'logOrchestratorError requires at least (message, err). Add the caught error as the 2nd argument.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'logOrchestratorError' &&
          node.arguments.length < 2
        ) {
          context.report({ node, messageId: 'logOrchestratorErrorNeedErr' });
          return;
        }

        if (node.callee.type !== 'MemberExpression') return;
        if (!isOrchestratorErrorCall(node.callee)) return;

        const args = node.arguments;
        const argc = args.length;

        if (argc < 2) {
          context.report({ node, messageId: 'needSecondArg' });
          return;
        }

        if (argc === 2 && isErrorLikeSecondArg(args[1])) {
          context.report({ node: args[1], messageId: 'needThirdArgWhenError' });
        }
      },
    };
  },
};

/** @type {import('eslint').ESLint.Plugin} */
export const phoenixOrchestratorLogging = {
  meta: { name: 'eslint-plugin-phoenix-orchestrator-logging', version: '1.0.0' },
  rules: {
    'orchestrator-logger-error-context': orchestratorLoggerErrorContext,
  },
};
