import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

type BabelTypes = typeof t;

export class ImportUtil {
  constructor(private t: BabelTypes, private program: NodePath<t.Program>) {}

  removeImport(moduleSpecifier: string, exportedName: string) {
    for (let topLevelPath of this.program.get('body')) {
      if (
        !topLevelPath.isImportDeclaration() ||
        topLevelPath.get('source').node.value !== moduleSpecifier
      ) {
        continue;
      }

      let importSpecifierPath = topLevelPath
        .get('specifiers')
        .find((specifierPath) => matchSpecifier(specifierPath, exportedName));
      if (importSpecifierPath) {
        if (topLevelPath.node.specifiers.length === 1) {
          topLevelPath.remove();
        } else {
          importSpecifierPath.remove();
        }
      }
    }
  }

  // Import the given value (if needed) and return an Identifier representing
  // it.
  import(
    // the spot at which you will insert the Identifier we return to you
    target: NodePath<t.Node>,

    // the path to the module you're importing from
    moduleSpecifier: string,

    // the name you're importing from that module. Use "default" for the default
    // export. Use "*" for the namespace.
    exportedName: string,

    // Optional hint for helping us pick a name for the imported binding
    nameHint?: string
  ): t.Identifier {
    let declaration = this.program
      .get('body')
      .find((elt) => elt.isImportDeclaration() && elt.node.source.value === moduleSpecifier) as
      | undefined
      | NodePath<t.ImportDeclaration>;
    if (declaration) {
      let specifier = declaration
        .get('specifiers')
        .find((spec) => matchSpecifier(spec, exportedName));
      if (specifier && target.scope.getBinding(specifier.node.local.name)?.kind === 'module') {
        return this.t.identifier(specifier.node.local.name);
      } else {
        return this.addSpecifier(target, declaration, exportedName, nameHint);
      }
    } else {
      this.program.node.body.unshift(
        this.t.importDeclaration([], this.t.stringLiteral(moduleSpecifier))
      );
      return this.addSpecifier(
        target,
        this.program.get(`body.0`) as NodePath<t.ImportDeclaration>,
        exportedName,
        nameHint
      );
    }
  }

  private addSpecifier(
    target: NodePath<t.Node>,
    declaration: NodePath<t.ImportDeclaration>,
    exportedName: string,
    nameHint: string | undefined
  ): t.Identifier {
    let local = this.t.identifier(
      unusedNameLike(target, desiredName(nameHint, exportedName, target))
    );
    let specifier = this.buildSpecifier(exportedName, local);
    declaration.node.specifiers.push(specifier);
    declaration.scope.registerBinding(
      'module',
      declaration.get(`specifiers.${declaration.node.specifiers.length - 1}`) as NodePath
    );
    return local;
  }

  private buildSpecifier(exportedName: string, localName: t.Identifier) {
    switch (exportedName) {
      case 'default':
        return this.t.importDefaultSpecifier(localName);
      case '*':
        return this.t.importNamespaceSpecifier(localName);
      default:
        return this.t.importSpecifier(localName, this.t.identifier(exportedName));
    }
  }
}

function unusedNameLike(path: NodePath<t.Node>, name: string): string {
  let candidate = name;
  let counter = 0;
  while (path.scope.hasBinding(candidate)) {
    candidate = `${name}${counter++}`;
  }
  return candidate;
}

function name(node: t.StringLiteral | t.Identifier): string {
  if (node.type === 'StringLiteral') {
    return node.value;
  } else {
    return node.name;
  }
}

function desiredName(nameHint: string | undefined, exportedName: string, target: NodePath<t.Node>) {
  if (nameHint) {
    return nameHint;
  }
  if (exportedName === 'default' || exportedName === '*') {
    if (target.isIdentifier()) {
      return target.node.name;
    } else {
      return target.scope.generateUidIdentifierBasedOnNode(target.node).name;
    }
  } else {
    return exportedName;
  }
}

function matchSpecifier(spec: NodePath<any>, exportedName: string): boolean {
  switch (exportedName) {
    case 'default':
      return spec.isImportDefaultSpecifier();
    case '*':
      return spec.isImportNamespaceSpecifier();
    default:
      return spec.isImportSpecifier() && name(spec.node.imported) === exportedName;
  }
}
