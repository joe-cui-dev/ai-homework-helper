import fs from "fs";
import path from "path";
import ts from "typescript";

type EventShape = { discriminator: string; fields: string[] };

const streamEventShapes = (filePath: string): EventShape[] => {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === "StreamEvent");
  if (!declaration || !ts.isUnionTypeNode(declaration.type)) {
    throw new Error(`${filePath} must declare StreamEvent as a union.`);
  }
  return declaration.type.types.map((variant) => {
    if (!ts.isTypeLiteralNode(variant)) throw new Error("StreamEvent variants must be object literals.");
    const properties = variant.members.filter(ts.isPropertySignature);
    const discriminatorProperty = properties.find((property) => property.name.getText(source) === "type");
    if (!discriminatorProperty?.type || !ts.isLiteralTypeNode(discriminatorProperty.type)) {
      throw new Error("Every StreamEvent variant needs a literal type discriminator.");
    }
    const discriminator = discriminatorProperty.type.literal.getText(source).replace(/["']/g, "");
    const fields = properties.map((property) => {
      const name = property.name.getText(source);
      const optional = property.questionToken ? "?" : "!";
      const type = property.type?.getText(source).replace(/\s+/g, "") ?? "unknown";
      return `${name}${optional}:${type}`;
    }).sort();
    return { discriminator, fields };
  }).sort((left, right) => left.discriminator.localeCompare(right.discriminator));
};

describe("frontend/backend streaming contract", () => {
  it("keeps event discriminators, required fields, and field types in sync", () => {
    const backendTypes = path.resolve(__dirname, "../shared/types.ts");
    const frontendTypes = path.resolve(__dirname, "../../../frontend/src/types.ts");
    expect(streamEventShapes(frontendTypes)).toEqual(streamEventShapes(backendTypes));
  });
});
