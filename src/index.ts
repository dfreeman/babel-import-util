import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

type BabelTypes = typeof t;

export class ImportUtil {
  constructor(private t: BabelTypes, private program: NodePath<t.Program>) {}

  // remove one imported binding. If this is the last thing imported from the
  // given moduleSpecifier, the whole statement will also be removed.
  removeImport(moduleSpecifier: string, exportedName: string): void {
    for (let topLevelPath of this.program.get('body')) {
      if (!matchModule(topLevelPath, moduleSpecifier)) {
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

  // remove all imports from the given moduleSpecifier
  removeAllImports(moduleSpecifier: string): void {
    for (let topLevelPath of this.program.get('body')) {
      if (matchModule(topLevelPath, moduleSpecifier)) {
        topLevelPath.remove();
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
    let declarations = this.findImportsFrom(moduleSpecifier);
    let identifier = this.findIdentifierToReuse(target, declarations, exportedName);
    if (identifier) {
      return identifier;
    }

    // We always keep namespace imports as their own statement to avoid winding up
    // with illegal combinations of import specifier types.
    let declaration = declarations.find((decl) => !isNamespaceImport(decl));
    if (!declaration || exportedName === '*') {
      // If there's no existing declaration or we're adding a namespace import,
      // create a fresh declaration and add it to the program.
      this.program.node.body.unshift(
        this.t.importDeclaration([], this.t.stringLiteral(moduleSpecifier))
      );

      declaration = this.program.get('body.0') as NodePath<t.ImportDeclaration>;
    }

    return this.addSpecifier(target, declaration, exportedName, nameHint);
  }

  importForSideEffect(moduleSpecifier: string): void {
    let declarations = this.findImportsFrom(moduleSpecifier);
    if (!declarations.length) {
      this.program.node.body.unshift(
        this.t.importDeclaration([], this.t.stringLiteral(moduleSpecifier))
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

    // Babel prints default imports incorrectly if they appear after named import specifiers
    if (exportedName === 'default') {
      declaration.node.specifiers.unshift(specifier);
    } else {
      declaration.node.specifiers.push(specifier);
    }

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

  private findImportsFrom(moduleSpecifier: string): Array<NodePath<t.ImportDeclaration>> {
    return this.program.get('body').filter((path): path is NodePath<t.ImportDeclaration> => {
      return path.isImportDeclaration() && path.node.source.value === moduleSpecifier;
    });
  }

  private findIdentifierToReuse(
    target: NodePath<t.Node>,
    declarations: Array<NodePath<t.ImportDeclaration>>,
    exportedName: string
  ): t.Identifier | void {
    let specifier = findSpecifierFor(declarations, exportedName);
    if (specifier && target.scope.getBinding(specifier.node.local.name)?.kind === 'module') {
      return this.t.identifier(specifier.node.local.name);
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
    // first we opportunistically do camelization when an illegal character is
    // followed by a lowercase letter, in an effort to aid readability of the
    // output.
    let cleaned = nameHint.replace(/[^a-zA-Z_]([a-z])/g, (_m, letter) => letter.toUpperCase());
    // then we unliterally strip all remaining illegal characters.
    cleaned = cleaned.replace(/[^a-zA-Z_]/g, '');
    return cleaned;
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

function isNamespaceImport(path: NodePath<t.ImportDeclaration>): boolean {
  let specs = path.node.specifiers;
  return specs[specs.length - 1]?.type === 'ImportNamespaceSpecifier';
}

function findSpecifierFor(
  declarations: Array<NodePath<t.ImportDeclaration>>,
  exportedName: string
): NodePath<t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier> | null {
  for (let declaration of declarations) {
    let specifier = declaration
      .get('specifiers')
      .find((spec) => matchSpecifier(spec, exportedName));

    if (specifier) {
      return specifier;
    }
  }
  return null;
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

function matchModule(
  path: NodePath<any>,
  moduleSpecifier: string
): path is NodePath<t.ImportDeclaration> {
  return path.isImportDeclaration() && path.get('source').node.value === moduleSpecifier;
}
