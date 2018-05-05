import * as llvm from "llvm-node";
import * as R from "ramda";
import * as ts from "typescript";
import { error, warn } from "./diagnostics";
import { mangleFunctionDeclaration } from "./mangle";
import { Scope, SymbolTable } from "./symbol-table";
import { isConst } from "./tsc-utils";
import { getLLVMType, getStringType } from "./types";

export function emitLLVM(program: ts.Program): llvm.Module {
  const checker = program.getTypeChecker();
  const context = new llvm.LLVMContext();
  const module = new llvm.Module("main", context);
  const generator = new LLVMGenerator(checker, module, context);

  for (const sourceFile of program.getSourceFiles()) {
    generator.emitSourceFile(sourceFile);
  }

  llvm.verifyModule(module);
  return module;
}

class LLVMGenerator {
  private readonly checker: ts.TypeChecker;
  private readonly module: llvm.Module;
  private readonly context: llvm.LLVMContext;
  private readonly builder: llvm.IRBuilder;
  private readonly symbolTable: SymbolTable;

  constructor(checker: ts.TypeChecker, module: llvm.Module, context: llvm.LLVMContext) {
    this.checker = checker;
    this.module = module;
    this.context = context;
    this.builder = new llvm.IRBuilder(context);
    this.symbolTable = new SymbolTable();
  }

  emitSourceFile(sourceFile: ts.SourceFile) {
    sourceFile.forEachChild(node => this.emitNode(node, this.symbolTable.globalScope));
  }

  emitNode(node: ts.Node, parentScope: Scope): void {
    switch (node.kind) {
      case ts.SyntaxKind.FunctionDeclaration:
        this.emitFunctionDeclaration(node as ts.FunctionDeclaration, parentScope);
        break;
      case ts.SyntaxKind.ModuleDeclaration:
        this.emitModuleDeclaration(node as ts.ModuleDeclaration, parentScope);
        break;
      case ts.SyntaxKind.Block:
        this.emitBlock(node as ts.Block);
        break;
      case ts.SyntaxKind.ExpressionStatement:
        this.emitExpressionStatement(node as ts.ExpressionStatement);
        break;
      case ts.SyntaxKind.IfStatement:
        this.emitIfStatement(node as ts.IfStatement, parentScope);
        break;
      case ts.SyntaxKind.ReturnStatement:
        this.emitReturnStatement(node as ts.ReturnStatement);
        break;
      case ts.SyntaxKind.VariableStatement:
        this.emitVariableStatement(node as ts.VariableStatement, parentScope);
        break;
      case ts.SyntaxKind.EndOfFileToken:
        break;
      default:
        warn(`Unhandled ts.Node '${ts.SyntaxKind[node.kind]}'`);
    }
  }

  emitFunctionDeclaration(declaration: ts.FunctionDeclaration, parentScope: Scope): void {
    const signature = this.checker.getSignatureFromDeclaration(declaration)!;
    const returnType = getLLVMType(this.checker.typeToTypeNode(signature.getReturnType()), this.context);
    const parameterTypes = declaration.parameters.map(parameter => getLLVMType(parameter.type!, this.context));
    const type = llvm.FunctionType.get(returnType, parameterTypes, false);
    const linkage = llvm.LinkageTypes.ExternalLinkage;
    const qualifiedName = mangleFunctionDeclaration(declaration, parentScope);
    const func = llvm.Function.create(type, linkage, qualifiedName, this.module);
    const body = declaration.body;

    if (body) {
      this.symbolTable.withScope(qualifiedName, bodyScope => {
        for (const [parameter, argument] of R.zip(signature.parameters, func.getArguments())) {
          argument.name = parameter.name;
          bodyScope.set(parameter.name, argument);
        }

        const entryBlock = llvm.BasicBlock.create(this.context, "entry", func);
        this.builder.setInsertionPoint(entryBlock);
        body.forEachChild(node => this.emitNode(node, bodyScope));

        if (!this.builder.getInsertBlock().getTerminator()) {
          if (returnType.isVoidTy()) {
            this.builder.createRetVoid();
          } else {
            // TODO: Emit LLVM 'unreachable' instruction.
          }
        }
      });
    }

    llvm.verifyFunction(func);
    parentScope.set(declaration.name!.text, func);
  }

  emitModuleDeclaration(declaration: ts.ModuleDeclaration, parentScope: Scope): void {
    const name = declaration.name.text;
    const scope = new Scope(name);
    declaration.body!.forEachChild(node => this.emitNode(node, scope));
    parentScope.set(name, scope);
  }

  emitBlock(block: ts.Block): void {
    this.symbolTable.withScope(undefined, scope => {
      for (const statement of block.statements) {
        this.emitNode(statement, scope);
      }
    });
  }

  emitFoo(
    block: ts.Statement | undefined,
    destination: llvm.BasicBlock,
    continuation: llvm.BasicBlock,
    parentScope: Scope
  ): void {
    this.builder.setInsertionPoint(destination);

    if (block) {
      this.emitNode(block, parentScope);
    }

    if (!this.builder.getInsertBlock().getTerminator()) {
      this.builder.createBr(continuation);
    }
  }

  emitExpressionStatement(statement: ts.ExpressionStatement): void {
    this.emitExpression(statement.expression);
  }

  emitIfStatement(statement: ts.IfStatement, parentScope: Scope): void {
    const condition = this.emitExpression(statement.expression);
    const thenBlock = llvm.BasicBlock.create(this.context, "then", this.currentFunction);
    const elseBlock = llvm.BasicBlock.create(this.context, "else", this.currentFunction);
    const endBlock = llvm.BasicBlock.create(this.context, "endif", this.currentFunction);
    this.builder.createCondBr(condition, thenBlock, elseBlock);
    this.emitFoo(statement.thenStatement, thenBlock, endBlock, parentScope);
    this.emitFoo(statement.elseStatement, elseBlock, endBlock, parentScope);
    this.builder.setInsertionPoint(endBlock);
  }

  emitReturnStatement(statement: ts.ReturnStatement): void {
    if (statement.expression) {
      this.builder.createRet(this.createLoadIfAlloca(this.emitExpression(statement.expression)));
    } else {
      this.builder.createRetVoid();
    }
  }

  emitVariableStatement(statement: ts.VariableStatement, parentScope: Scope): void {
    for (const declaration of statement.declarationList.declarations) {
      // TODO: Handle destructuring declarations.
      const name = declaration.name.getText();
      const initializer = this.createLoadIfAlloca(this.emitExpression(declaration.initializer!));

      if (isConst(declaration)) {
        if (!initializer.hasName()) {
          initializer.name = name;
        }
        parentScope.set(name, initializer);
      } else {
        const type = this.checker.typeToTypeNode(this.checker.getTypeAtLocation(declaration));
        const alloca = this.createEntryBlockAlloca(getLLVMType(type, this.context), name);
        this.builder.createStore(initializer, alloca);
        parentScope.set(name, alloca);
      }
    }
  }

  emitExpression(expression: ts.Expression): llvm.Value {
    switch (expression.kind) {
      case ts.SyntaxKind.BinaryExpression:
        return this.emitBinaryExpression(expression as ts.BinaryExpression);
      case ts.SyntaxKind.CallExpression:
        return this.emitCallExpression(expression as ts.CallExpression);
      case ts.SyntaxKind.PropertyAccessExpression:
        return this.emitPropertyAccessExpression(expression as ts.PropertyAccessExpression);
      case ts.SyntaxKind.Identifier:
        return this.emitIdentifier(expression as ts.Identifier);
      case ts.SyntaxKind.TrueKeyword:
      case ts.SyntaxKind.FalseKeyword:
        return this.emitBooleanLiteral(expression as ts.BooleanLiteral);
      case ts.SyntaxKind.StringLiteral:
        return this.emitStringLiteral(expression as ts.StringLiteral);
      default:
        return error(`Unhandled ts.Expression '${ts.SyntaxKind[expression.kind]}'`);
    }
  }

  emitBinaryExpression(expression: ts.BinaryExpression): llvm.Value {
    const left = this.emitExpression(expression.left);
    const right = this.emitExpression(expression.right);

    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.EqualsToken:
        return this.builder.createStore(this.createLoadIfAlloca(right), left);
      case ts.SyntaxKind.PlusToken:
        return this.builder.createFAdd(this.createLoadIfAlloca(left), this.createLoadIfAlloca(right));
      default:
        return error(`Unhandled ts.BinaryExpression operator '${ts.SyntaxKind[expression.operatorToken.kind]}'`);
    }
  }

  emitCallExpression(expression: ts.CallExpression): llvm.Value {
    const callee = this.emitExpression(expression.expression);
    const args = expression.arguments.map(argument => this.emitExpression(argument));
    return this.builder.createCall(callee, args);
  }

  emitPropertyAccessExpression(expression: ts.PropertyAccessExpression): llvm.Value {
    const left = expression.expression;
    const propertyName = expression.name.text;

    // TODO: Handle arbitrarily long namespace access chains.
    if (ts.isIdentifier(left)) {
      const value = this.symbolTable.get(left.text);
      if (value instanceof Scope) {
        return value.get(propertyName) as llvm.Value;
      }
    }

    // TODO: Implement object property access.
    return error("Object property access not implemented yet");
  }

  emitIdentifier(expression: ts.Identifier): llvm.Value {
    return this.symbolTable.get(expression.text) as llvm.Value;
  }

  emitBooleanLiteral(expression: ts.BooleanLiteral): llvm.Value {
    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      return llvm.ConstantInt.getTrue(this.context);
    } else {
      return llvm.ConstantInt.getFalse(this.context);
    }
  }

  emitStringLiteral(expression: ts.StringLiteral): llvm.Value {
    const ptr = this.builder.createGlobalStringPtr(expression.text) as llvm.Constant;
    const length = llvm.ConstantInt.get(this.context, expression.text.length);
    return llvm.ConstantStruct.get(getStringType(this.context), [ptr, length]);
  }

  createLoadIfAlloca(value: llvm.Value): llvm.Value {
    if (value instanceof llvm.AllocaInst) {
      return this.builder.createLoad(value);
    }
    return value;
  }

  createEntryBlockAlloca(type: llvm.Type, name: string): llvm.AllocaInst {
    const builder = new llvm.IRBuilder(this.currentFunction.getEntryBlock()!);
    const arraySize = undefined;
    return builder.createAlloca(type, arraySize, name);
  }

  get currentFunction(): llvm.Function {
    return this.builder.getInsertBlock().parent!;
  }
}
