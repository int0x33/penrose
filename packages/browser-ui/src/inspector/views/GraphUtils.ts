import {
  ShapeTypes,
  PenroseState,
  PenroseFn,
  prettyPrintFn,
  prettyPrintPath,
  prettyPrintExpr,
  graphOfBlockExpr,
} from "@penrose/core";
import { FieldDict, Translation } from "@penrose/core/build/dist/types/value";
import { uniqBy } from "lodash";

// Flatten a list of lists into a single list of elements
const merge = (arr: any) => [].concat(...arr);

// Given a parent node, returns the graph corresponding to nodes and edges of children
// May contain duplicate nodes
// TODO: Move this to utils?
// TODO: Add type for graph and VarAD
const traverseGraphTopDown = (par: any): any => {
  const parNode = { id: par.id, label: par.op };
  const edges = par.children.map((edge) => ({
    from: parNode.id,
    to: edge.node.id,
  }));

  const subgraphs = par.children.map((edge) => traverseGraphTopDown(edge.node));
  const subnodes = merge(subgraphs.map((g) => g.nodes));
  const subedges = merge(subgraphs.map((g) => g.edges));

  return {
    nodes: [parNode].concat(subnodes),
    edges: edges.concat(subedges),
  };
};

// For building atomic op graph. Returns unique nodes after all nodes are merged
export const traverseUnique = (par: any): any => {
  const g = traverseGraphTopDown(par);
  return {
    ...g,
    nodes: uniqBy(g.nodes, (e: any) => e.id),
  };
};

// Convert from `traverseUnique` schema to cytoscape schema
export const convertSchema = (graph: any): any => {
  const { nodes, edges } = graph;

  const nodes2 = nodes.map((e) => ({
    data: {
      id: String(e.id), // this needs to be unique
      label: e.label,
    },
  }));

  const edges2 = edges.map((e) => ({
    data: {
      id: String(e.from) + " -> " + String(e.to), // NOTE: No duplicate edges
      source: String(e.from),
      target: String(e.to),
      // No label
    },
  }));

  return { nodes: nodes2, edges: edges2 };
};

// -----

// For opt fn graph
// TODO: Import `Fn` for the types
// TODO: Hover to show outgoing edges (cytoscape)
// TODO / NOTE: This does not work with inline computations (e.g. f(g(p), x)). Everything needs to be a path
export const toGraphOpt = (
  objfns: PenroseFn[],
  constrfns: PenroseFn[],
  varyingPaths: any[]
): any => {
  // One node for each unique path, id = path name, name = path name
  // One node for each unique obj/constr application, id = the function w/ its args, name = function name
  // One edge for each function=>path application, id = from + to names, name = none

  // TODO: Could instead be the union of shapePaths and varyingPaths if we want to show all optimizable paths, not just the ones that are optimized
  const allFns = objfns.concat(constrfns);
  const allArgs: string[] = merge(
    allFns.map((f) => f.fargs.map(prettyPrintExpr))
  ); // TODO: This also includes constants, etc.

  const argNodes = allArgs.map((p) => ({
    data: {
      id: p,
      label: p,
    },
  }));

  // TODO <<< Put in edges for varyingPathNodes?
  const varyingPathNodes = varyingPaths.map((p) => {
    const res = prettyPrintPath(p);
    return {
      data: {
        id: res,
        label: res,
      },
    };
  });

  // TODO: Show objectives separately from constraints?? Or at least style them differently
  const fnNodes = allFns.map((f) => ({
    data: {
      id: prettyPrintFn(f),
      label: f.fname,
      type: f.optType,
    },
  }));

  const nodes = argNodes.concat(fnNodes).concat(varyingPathNodes);

  const edges = merge(
    allFns.map((f) =>
      f.fargs.map((arg) => ({
        data: {
          id: prettyPrintFn(f) + " -> " + prettyPrintExpr(arg),
          source: prettyPrintFn(f), // Matches existing fn ids
          target: prettyPrintExpr(arg), // Matches existing path ids
        },
      }))
    )
  );

  return {
    nodes,
    edges,
  };
};

// ----------

// For translation (render) graph

// TODO: import translation
export const toGraphTrans = (trans: Translation, varyingPaths: any) => {
  const tr = trans.trMap;

  // Top nodes = All Substance objects, fields, and properties [Translation]
  // + Middle nodes = All computations -- involving all operations and paths
  // + Leaf nodes = All constants, paths, and varying vars

  // Edges from top to middle = All subpaths (from Substance objects to their fields and/or properties)
  // Edges from middle to bottom = All path values (assignments to paths) and computations

  // TODO: Write using a for-loop, and a form of checkBlockExpr

  let nodes: any[] = [];
  let edges: any[] = [];

  for (const [subObj, fieldDict] of Object.entries(tr)) {
    const subNode = {
      data: {
        id: subObj,
        label: subObj,
        type: "sub obj",
      },
    };

    nodes.push(subNode);

    // cytoscape insanity - can't use "x.y" syntax in string arguments as it somehow escapes the string and causes a crash
    // also TODO - not sure how to type vars in loops (fieldDict)
    const fieldDict2: FieldDict = fieldDict;
    for (const [field, fexpr] of Object.entries(fieldDict2)) {
      const fieldStr = subObj + ":" + field;

      const fieldNode = {
        data: {
          id: fieldStr,
          label: field,
          type: "field",
        },
      };

      const fieldEdge = {
        data: {
          id: subObj + " -> " + fieldStr,
          source: subObj,
          target: fieldStr,
        },
      };

      nodes.push(fieldNode);
      edges.push(fieldEdge);

      if (fexpr.tag === "FExpr") {
        // TODO <<< Look up if varying path, and make special ? node
        // Else use checkBlockExpr
        const res = fexpr.contents;
        let head;

        if (res.tag === "OptEval") {
          const e = res.contents;
          const graph = graphOfBlockExpr(e);
          // TODO: Make sure the head node is the first one in the result
          head = graph.nodes[0];
          console.log("expr", e);
          console.log("resulting graph", graph, head);
          console.log("in", fieldNode, head);

          // Connect the head node to its parent
          const exprEdge = {
            data: {
              id: fieldNode.data.id + " -> " + head.data.id,
              source: fieldNode.data.id,
              target: head.data.id,
            },
          };

          nodes = nodes.concat(graph.nodes);
          edges = edges.concat(graph.edges);
          edges.push(exprEdge);

          console.log("exprEdge", exprEdge, nodes, edges);
        } else if (res.tag === "Done") {
          // Const, TODO
          // Make a const node and connect it to its parent
          const constNode = {
            data: {
              // TODO: Fix this id
              id: JSON.stringify(res.contents),
              // TODO: Fix this label
              label: "const",
              type: "const",
            },
          };

          head = constNode;
        } else if (res.tag === "Pending") {
          // Const, TODO
          // Make a const node and connect it to its parent
          throw Error("Pending");
        }

        const constEdge = {
          data: {
            id: fieldStr + " -> " + head.data.id,
            source: fieldStr,
            target: head.data.id,
          },
        };

        nodes.push(head);
        edges.push(constEdge);
      } else if (fexpr.tag === "FGPI") {
        const [typ, props] = fexpr.contents;
        const typeStr = fieldStr + ":" + typ;
        const typeNode = {
          data: {
            id: typeStr,
            label: typ,
            type: "shape ctor",
          },
        };

        const typeEdge = {
          data: {
            id: fieldStr + " -> " + typ,
            source: fieldStr,
            target: typeStr,
          },
        };

        // console.log("fexpr", fexpr, typeStr, typeNode, typeEdge);

        nodes.push(typeNode);
        edges.push(typeEdge);

        for (const [prop, propExpr] of Object.entries(props)) {
          const propStr = typeStr + ":" + prop; // Because more than one shape can have the same property
          const propNode = {
            data: {
              id: propStr,
              label: prop,
              type: "property",
            },
          };

          const propEdge = {
            data: {
              id: typeStr + " -> " + propStr,
              source: typeStr,
              target: propStr,
            },
          };

          console.log("prop", prop, propStr, propNode, propEdge);

          nodes.push(propNode);
          edges.push(propEdge);

          // TODO <<< Do propExpr: TagExpr<VarAD>
          // Look up if varying path, and make special ? node
          // Else use checkBlockExpr
        } // end property loop
      } // end gpi case
    } // end field case
  } // end sub obj case

  return { nodes, edges };
};
