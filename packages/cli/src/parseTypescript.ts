const ts: any = {};

interface INode {
  queryName: string;
  queryText: string;
}

import { parseTSQuery, TSQueryAST, ParseEvent } from '@pgtyped/parser';

export type TSParseResult = { queries: TSQueryAST[]; events: ParseEvent[] };

export function parseFile(sourceFile: any): TSParseResult {
  const foundNodes: INode[] = [];
  parseNode(sourceFile);

  function parseNode(node: any) {
    if (node.kind === ts.SyntaxKind.TaggedTemplateExpression) {
      const queryName = node.parent.getChildren()[0].getText();
      const taggedTemplateNode = node as any;
      const tagName = taggedTemplateNode.tag.getText();
      const queryText = taggedTemplateNode.template
        .getText()
        .replace('\n', '')
        .slice(1, -1)
        .trim();
      if (tagName === 'sql') {
        foundNodes.push({
          queryName,
          queryText,
        });
      }
    }

    ts.forEachChild(node, parseNode);
  }

  const queries: TSQueryAST[] = [];
  const events: ParseEvent[] = [];
  for (const node of foundNodes) {
    const { query, events: qEvents } = parseTSQuery(
      node.queryText,
      node.queryName,
    );
    queries.push(query);
    events.push(...qEvents);
  }

  return { queries, events };
}

export const parseCode = (fileContent: string, fileName = 'unnamed.ts') => {
  const sourceFile = ts.createSourceFile(
    fileName,
    fileContent,
    ts.ScriptTarget.ES2015,
    true,
  );
  return parseFile(sourceFile);
};
