'use strict';
/**
 * Spec 15.7: arithmetic on monetary values outside the money module is refused by lint.
 * An identifier whose name ends in amount, fee, balance, total, value or minor (or their
 * snake-case forms) is monetary; multiplying, dividing or taking a remainder of one, or
 * adding and subtracting two of them, belongs in src/money.
 */
const MONEY = /(amount|fee|fees|balance|total|shortfall|remainder|minor|delta|free|open|reserved|encumbered|float)$/i;
function isMoney(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return MONEY.test(node.name);
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') return MONEY.test(node.property.name);
  return false;
}
module.exports = {
  meta: { type: 'problem', docs: { description: 'Money arithmetic lives in src/money' }, schema: [] },
  create(context) {
    return {
      BinaryExpression(node) {
        const both = isMoney(node.left) && isMoney(node.right);
        const either = isMoney(node.left) || isMoney(node.right);
        if ((['*', '/', '%', '**'].includes(node.operator) && either) || (['+', '-'].includes(node.operator) && both)) {
          context.report({ node, message: `Arithmetic on monetary values ("${node.operator}") belongs in src/money (spec 15.7); use sum/subtract/computeFee.` });
        }
      },
    };
  },
};
