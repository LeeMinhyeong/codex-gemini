const { isDeepStrictEqual } = require("node:util");

const KEYWORDS = new Set([
  "$schema", "$id", "$defs", "definitions", "$ref", "title", "description", "default", "examples",
  "type", "const", "enum", "properties", "required", "additionalProperties", "items",
  "minimum", "maximum", "minItems", "maxItems", "minLength", "pattern", "uniqueItems",
]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function pointer(path, token) {
  return `${path}/${String(token).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function resolveRef(root, reference) {
  if (reference === "#") return root;
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  }
  return reference.slice(2).split("/").reduce((node, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object" || !(key in node)) {
      throw new Error(`Unresolved JSON Schema reference: ${reference}`);
    }
    return node[key];
  }, root);
}

function assertSupportedJsonSchema(schema) {
  function visit(node, path = "#") {
    if (typeof node === "boolean") return;
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error(`JSON Schema node at ${path} must be an object or boolean.`);
    }
    for (const keyword of Object.keys(node)) {
      if (!KEYWORDS.has(keyword)) throw new Error(`Unsupported JSON Schema keyword at ${path}: ${keyword}`);
    }
    if (node.$ref !== undefined) resolveRef(schema, node.$ref);
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.length === 0 || types.some((type) => !TYPES.has(type))) {
        throw new Error(`type at ${path} contains an unsupported JSON type.`);
      }
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
      throw new Error(`enum at ${path} must be a non-empty array.`);
    }
    if (node.required !== undefined
        && (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string"))) {
      throw new Error(`required at ${path} must be an array of strings.`);
    }
    for (const keyword of ["minimum", "maximum"]) {
      if (node[keyword] !== undefined && typeof node[keyword] !== "number") {
        throw new Error(`${keyword} at ${path} must be a number.`);
      }
    }
    for (const keyword of ["minItems", "maxItems"]) {
      if (node[keyword] !== undefined && (!Number.isInteger(node[keyword]) || node[keyword] < 0)) {
        throw new Error(`${keyword} at ${path} must be a non-negative integer.`);
      }
    }
    if (node.minLength !== undefined && (!Number.isInteger(node.minLength) || node.minLength < 0)) {
      throw new Error(`minLength at ${path} must be a non-negative integer.`);
    }
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== "string") throw new Error(`pattern at ${path} must be a string.`);
      try {
        new RegExp(node.pattern);
      } catch (error) {
        throw new Error(`pattern at ${path} is invalid: ${error.message}`);
      }
    }
    if (node.uniqueItems !== undefined && typeof node.uniqueItems !== "boolean") {
      throw new Error(`uniqueItems at ${path} must be boolean.`);
    }
    for (const container of ["properties", "$defs", "definitions"]) {
      if (node[container] === undefined) continue;
      if (!node[container] || typeof node[container] !== "object" || Array.isArray(node[container])) {
        throw new Error(`${container} at ${path} must be an object.`);
      }
      for (const [key, child] of Object.entries(node[container])) visit(child, `${path}/${container}/${key}`);
    }
    for (const keyword of ["items", "additionalProperties"]) {
      if (node[keyword] !== undefined && typeof node[keyword] !== "boolean") {
        visit(node[keyword], `${path}/${keyword}`);
      }
    }
  }
  visit(schema);
}

function validateJsonSchema(value, schema) {
  const errors = [];
  const activeRefs = new Set();
  const add = (path, keyword, expected, actual, message) => errors.push({
    path: path || "/", keyword, expected, actual, message,
  });

  function visit(instance, node, path = "") {
    if (node === true) return;
    if (node === false) {
      add(path, "falseSchema", true, false, "Value is rejected by the schema.");
      return;
    }
    if (node.$ref) {
      const key = `${node.$ref}|${path}`;
      if (!activeRefs.has(key)) {
        activeRefs.add(key);
        visit(instance, resolveRef(schema, node.$ref), path);
        activeRefs.delete(key);
      }
    }
    if (node.const !== undefined && !isDeepStrictEqual(instance, node.const)) {
      add(path, "const", node.const, instance, "Value does not match const.");
    }
    if (node.enum && !node.enum.some((item) => isDeepStrictEqual(item, instance))) {
      add(path, "enum", node.enum, instance, "Value is not in the allowed enum.");
    }

    const types = node.type === undefined ? null : Array.isArray(node.type) ? node.type : [node.type];
    const actualType = valueType(instance);
    if (types && !types.some((type) => type === actualType || (type === "number" && actualType === "integer"))) {
      add(path, "type", types, actualType, `Expected ${types.join(" or ")}, received ${actualType}.`);
      return;
    }

    if (typeof instance === "number") {
      if (node.minimum !== undefined && instance < node.minimum) {
        add(path, "minimum", node.minimum, instance, "Number is below the minimum.");
      }
      if (node.maximum !== undefined && instance > node.maximum) {
        add(path, "maximum", node.maximum, instance, "Number exceeds the maximum.");
      }
    }
    if (typeof instance === "string") {
      if (node.minLength !== undefined && instance.length < node.minLength) {
        add(path, "minLength", node.minLength, instance.length, "String is too short.");
      }
      if (node.pattern !== undefined && !new RegExp(node.pattern).test(instance)) {
        add(path, "pattern", node.pattern, instance, "String does not match the required pattern.");
      }
    }
    if (Array.isArray(instance)) {
      if (node.minItems !== undefined && instance.length < node.minItems) {
        add(path, "minItems", node.minItems, instance.length, "Array has too few items.");
      }
      if (node.maxItems !== undefined && instance.length > node.maxItems) {
        add(path, "maxItems", node.maxItems, instance.length, "Array has too many items.");
      }
      if (node.uniqueItems) {
        const hasDuplicate = instance.some((item, index) => (
          instance.slice(index + 1).some((other) => isDeepStrictEqual(item, other))
        ));
        if (hasDuplicate) {
          add(path, "uniqueItems", true, false, "Array items must be unique.");
        }
      }
      if (node.items !== undefined) {
        instance.forEach((item, index) => visit(item, node.items, pointer(path, index)));
      }
    }
    if (instance && typeof instance === "object" && !Array.isArray(instance)) {
      const properties = node.properties || {};
      for (const key of node.required || []) {
        if (!Object.prototype.hasOwnProperty.call(instance, key)) {
          add(pointer(path, key), "required", true, false, `Required property ${key} is missing.`);
        }
      }
      for (const [key, child] of Object.entries(instance)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          visit(child, properties[key], pointer(path, key));
        } else if (node.additionalProperties === false) {
          add(pointer(path, key), "additionalProperties", false, key, `Unexpected property ${key}.`);
        } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
          visit(child, node.additionalProperties, pointer(path, key));
        }
      }
    }
  }

  visit(value, schema);
  return errors;
}

function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function validateScopeManifest(response, manifest, { strictText = false } = {}) {
  if (!manifest || !Array.isArray(manifest.allowed_files)) {
    throw new Error("Scope manifest must contain an allowed_files array.");
  }
  const errors = [];
  const allowed = new Set(manifest.allowed_files.map(normalizePath));
  const add = (path, expected, actual, message) => errors.push({
    path, keyword: "scope", expected, actual: actual ?? null, message,
  });
  const checkPath = (value, path) => {
    if (typeof value !== "string" || !allowed.has(normalizePath(value))) {
      add(path, [...allowed], value, "Path is not an exact member of the scope allowlist.");
    }
  };

  if (!response || typeof response !== "object" || Array.isArray(response)) {
    add("/", "JSON object", valueType(response), "Scope validation requires a JSON object.");
    return errors;
  }
  if (manifest.scope_id !== undefined && response.scope_id !== manifest.scope_id) {
    add("/scope_id", manifest.scope_id, response.scope_id, "scope_id does not match the scope manifest.");
  }
  const compliance = response.scope_compliance;
  if (!compliance || typeof compliance !== "object" || Array.isArray(compliance)) {
    add("/scope_compliance", "object", valueType(compliance), "scope_compliance must be an object.");
  } else {
    if (manifest.mode !== undefined && compliance.mode !== manifest.mode) {
      add("/scope_compliance/mode", manifest.mode, compliance.mode, "Review mode does not match the scope manifest.");
    }
    if (compliance.used_tools !== false) add("/scope_compliance/used_tools", false, compliance.used_tools, "Tool use is not allowed.");
    if (compliance.used_external_search !== false) {
      add("/scope_compliance/used_external_search", false, compliance.used_external_search, "External search is not allowed.");
    }
    if (Array.isArray(compliance.reviewed_files)) {
      compliance.reviewed_files.forEach((file, index) => checkPath(file, `/scope_compliance/reviewed_files/${index}`));
    } else {
      add("/scope_compliance/reviewed_files", "array", valueType(compliance.reviewed_files), "reviewed_files must be an array.");
    }
    if (!Array.isArray(compliance.out_of_scope_files) || compliance.out_of_scope_files.length > 0) {
      add("/scope_compliance/out_of_scope_files", [], compliance.out_of_scope_files, "out_of_scope_files must be empty.");
    }
  }
  if (Array.isArray(response.findings)) {
    response.findings.forEach((finding, index) => checkPath(finding?.file, `/findings/${index}/file`));
  } else if (response.findings !== undefined) {
    add("/findings", "array", valueType(response.findings), "findings must be an array.");
  }

  if (strictText) {
    const pathPattern = /[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|mjs|cjs|kt|kts|md|ya?ml|json|sql|prisma|toml|xml|csv)/g;
    const inspect = (value, path) => {
      if (typeof value === "string") {
        for (const referenced of value.match(pathPattern) || []) {
          if (!allowed.has(normalizePath(referenced))) checkPath(referenced, path);
        }
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => inspect(item, pointer(path, index)));
      }
    };
    (response.findings || []).forEach((finding, index) => {
      for (const field of ["evidence", "issue", "recommendation"]) {
        inspect(finding?.[field], `/findings/${index}/${field}`);
      }
    });
    inspect(response.missing_context, "/missing_context");
    inspect(response.residual_risks, "/residual_risks");
  }
  return errors;
}

module.exports = { assertSupportedJsonSchema, validateJsonSchema, validateScopeManifest };
