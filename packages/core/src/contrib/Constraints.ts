import {
  absVal,
  add,
  addN,
  constOf,
  constOfIf,
  div,
  max,
  min,
  mul,
  neg,
  ops,
  squared,
  sub,
  ifCond,
  lt,
  sqrt,
  minN,
  maxN,
} from "engine/Autodiff";
import {
  inRange,
  overlap1D,
  pointInBox,
  noIntersectCircles,
  atDistOutside,
  looseIntersect,
} from "contrib/Utils";
import {
  convexPartitions,
  rectangleDifference,
  convexPolygonMinkowskiSDF,
} from "contrib/Minkowski";
import { 
  bboxFromShape,
  shapeCenter,
  shapeSize,
} from "contrib/Queries";
import * as _ from "lodash";
import { linePts } from "utils/OtherUtils";
import { isLinelike, isRectlike } from "renderer/ShapeDef";
import { VarAD } from "types/ad";
import { every } from "lodash";
import * as BBox from "engine/BBox";

// -------- Simple constraints
// Do not require shape quaries, operate directly with `VarAD` parameters.
const constrDictSimple = {

  /**
   * Require that the value `x` is less than the value `y`
   */
  equal: (x: VarAD, y: VarAD) => {
    return absVal(sub(x, y))
  },

  /**
   * Require that the value `x` is in the range defined by `[x0, x1]`.
   */
  inRange: (x: VarAD, x0: VarAD, x1: VarAD) => {
    return max(constOf(0), mul(sub(x, x0), sub(x, x1)));
  },

  /**
   * Require that the value `x` is less than the value `y` with optional offset `padding`
   */
  lessThan: (x: VarAD, y: VarAD, padding = 0) => {
    return add(sub(x, y), constOfIf(padding));
  },

  /**
   * Require that the value `x` is less than the value `y`, with steeper penalty
   */
  lessThanSq: (x: VarAD, y: VarAD) => {
    // if x < y then 0 else (x - y)^2
    return ifCond(lt(x, y), constOf(0), squared(sub(x, y)));
  },

  /**
   * Require that an interval `[l1, r1]` contains another interval `[l2, r2]`. If not possible, returns 0.
   */
  contains1D: ([l1, r1]: [VarAD, VarAD], [l2, r2]: [VarAD, VarAD]): VarAD => {
    // [if len2 <= len1,] require that (l2 > l1) & (r2 < r1)
    return add(constrDictSimple.lessThanSq(l1, l2), constrDictSimple.lessThanSq(r2, r1));
  },

  /**
   * Make scalar `c` disjoint from a range `left, right`.
   */
  disjointScalar: (c: any, left: any, right: any) => {
    const d = (x: VarAD, y: VarAD) => absVal(sub(x, y));

    // if (x \in [l, r]) then min(d(x,l), d(x,r)) else 0
    return ifCond(
      inRange(c, left, right),
      min(d(c, left), d(c, right)),
      constOf(0)
    );
  },

}

// -------- Specific constraints
// Defined only for specific use-case or specific shapes.
const constrDictSpecific = {

  /**
   * Require that a shape `s1` is disjoint from shape `s2`, based on the type of the shape, and with an optional `offset` between them (e.g. if `s1` should be disjoint from `s2` with margin `offset`).
   */
   disjointCircles: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    offset = 0.0
  ) => {
    const d = ops.vdist(shapeCenter([t1, s1]), shapeCenter([t2, s2]));
    const o = [s1.r.contents, s2.r.contents, constOf(10.0)];
    return sub(addN(o), d);
  },

  /**
   * Require that a shape `s1` is disjoint from shape `s2`, based on the type of the shape, and with an optional `offset` between them (e.g. if `s1` should be disjoint from `s2` with margin `offset`).
   */
  disjointPolygons: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    offset = 0.0
  ) => {
    const cp1 = convexPartitions(s1.points.contents);
    const cp2 = convexPartitions(
      s2.points.contents.map((p: VarAD[]) => ops.vneg(p))
    );
    const sdf = maxN(
      cp1.map((p1) => minN(
        cp2.map((p2) => convexPolygonMinkowskiSDF(p1, p2)))
      )
    );
    return neg(sdf);
  },

  /**
   * Require that a shape `s1` is disjoint from shape `s2`, based on the type of the shape, and with an optional `offset` between them (e.g. if `s1` should be disjoint from `s2` with margin `offset`).
   */
  disjointAABBs: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    offset = 0.0
  ) => {
    const box1 = bboxFromShape(t1, s1);
    const box2 = bboxFromShape(t2, s2);
    const [pc1, pc2] = rectangleDifference(box1, box2);
    const [xp, yp] = ops.vmul(constOf(0.5), ops.vadd(pc1, pc2));
    const [xr, yr] = ops.vmul(constOf(0.5), ops.vsub(pc2, pc1));
    const [xq, yq] = ops.vsub([absVal(xp), absVal(yp)], [xr, yr]);
    const e1 = sqrt(
      add(
        constOf(10e-15),
        add(
          squared(max(sub(xp, xr), constOf(0.0))),
          squared(max(sub(yp, yr), constOf(0.0)))
        )
      )
    );
    const e2 = neg(min(max(xq, yq), constOf(0.0)));
    return sub(e2, e1);
  },

  /**
   * Require that shape `s1` overlaps shape `s2` with some offset `padding`.
   */
  overlappingCircles: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    padding = 10
  ) => {
    return looseIntersect(
      shapeCenter([t1, s1]),
      s1.r.contents,
      shapeCenter([t2, s2]),
      s2.r.contents,
      constOfIf(padding)
    );
  },

  /**
   * Require that shape `s1` is tangent to shape `s2`.
   */
  tangentCircles: ([t1, s1]: [string, any], [t2, s2]: [string, any]) => {
    const d = ops.vdist(shapeCenter([t1, s1]), shapeCenter([t2, s2]));
    const r1 = s1.r.contents;
    const r2 = s2.r.contents;
    // Since we want equality
    return absVal(sub(d, sub(r1, r2)));
  },

  ptCircleIntersect: (p: VarAD[], [t, s]: [string, any]) => {
    if (t === "Circle") {
      const r = s.r.contents;
      const c = shapeCenter([t, s]);
      return squared(sub(ops.vdist(p, c), r));
    } else throw new Error(`${t} not supported for ptCircleIntersect`);
  },

  /**
   * Make two intervals disjoint. They must be 1D intervals (line-like shapes) sharing a y-coordinate.
   */
  disjointIntervals: ([t1, s1]: [string, any], [t2, s2]: [string, any]) => {
    if (!isLinelike(t1) || !isLinelike(t2)) {
      throw Error("expected two line-like shapes");
    }
    return overlap1D(
      [s1.start.contents[0], s1.end.contents[0]],
      [s2.start.contents[0], s2.end.contents[0]]
    );
  },

  /**
   * Require that two linelike shapes `l1` and `l2` are not crossing.
   */
  notCrossing: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    offset = 5.0
  ) => {
    // TODO: remake using Minkowski sums
    throw new Error(`Not implemented.`);
  },

  /**
   * Require that label `s2` is at a distance of `offset` from a point-like shape `s1`.
   */
  atDist: ([t1, s1]: [string, any], [t2, s2]: [string, any], offset: VarAD) => {
    // TODO: Account for the size/radius of the initial point, rather than just the center

    if (isRectlike(t2)) {
      let pt;
      if (isLinelike(t1)) {
        // Position label close to the arrow's end
        pt = { x: s1.end.contents[0], y: s1.end.contents[1] };
      } else {
        // Only assume shape1 has a center
        pt = { x: s1.center.contents[0], y: s1.center.contents[1] };
      }

      // Get polygon of text (box)
      // TODO: Make this a GPI property
      // TODO: Do this properly; Port the matrix stuff in `textPolygonFn` / `textPolygonFn2` in Shapes.hs
      // I wrote a version simplified to work for rectangles
      const text = s2;
      const rect = bboxFromShape(t2, text);
      
      return ifCond(
        pointInBox(pt, rect),
        // If the point is inside the box, push it outside w/ `noIntersect`
        noIntersectCircles(rect.center, rect.w, [pt.x, pt.y], constOf(2.0)),
        // If the point is outside the box, try to get the distance from the point to equal the desired distance
        atDistOutside(pt, rect, offset)
      );
    } else {
      throw Error(`unsupported shapes for 'atDist': ${t1}, ${t2}`);
    }
  },

  /**
   * Require that shape `s1` outside of `s2` with some offset `padding`.
   */
  outsideOf: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    padding = 10
  ) => {
    if (isRectlike(t1) && t2 === "Circle") {
      const s1BBox = bboxFromShape(t1, s1);
      const textR = max(s1BBox.w, s1BBox.h);
      const d = ops.vdist(shapeCenter([t1, s1]), shapeCenter([t2, s2]));
      return sub(add(add(s2.r.contents, textR), constOfIf(padding)), d);
    } else throw new Error(`${[t1, t2]} not supported for outsideOf`);
  },

  /**
   * Make an AABB rectangle contain an AABB (vertical or horizontal) line. (Special case of rect-rect disjoint). AA = axis-aligned
   */
  containsRectLineAA: ([t1, s1]: [string, any], [t2, s2]: [string, any]) => {
    if (!isRectlike(t1) || !isLinelike(t2)) {
      throw Error("expected two line-like shapes");
    }

    const box = bboxFromShape(t1, s1);
    const line = bboxFromShape(t2, s2);

    // Contains line both vertically and horizontally
    return add(
      constrDictSimple.contains1D(BBox.xRange(box), BBox.xRange(line)),
      constrDictSimple.contains1D(BBox.yRange(box), BBox.yRange(line))
    );
  },

}

// -------- General constraints
// Defined for all shapes, generally require shape queries or call multiple specific constraints.
const constrDictGeneral = {

  /**
   * Require that a shape `s1` is disjoint from shape `s2`, based on the type of the shape, and with an optional `offset` between them (e.g. if `s1` should be disjoint from `s2` with margin `offset`).
   */
  disjoint: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    offset = 0.0
  ) => {
    if (isLinelike(t1) && isLinelike(t2))
      return constrDictSpecific.notCrossing([t1, s1], [t2, s2], offset);
    else if (t1 === "Circle" && t2 === "Circle")
      return constrDictSpecific.disjointCircles([t1, s1], [t2, s2], offset);
    else if (t1 === "Polygon" && t2 === "Polygon")
      return constrDictSpecific.disjointPolygons([t1, s1], [t2, s2], offset);
    else
      return constrDictSpecific.disjointAABBs([t1, s1], [t2, s2], offset);
  },
  
  /**
   * Require that shape `s1` overlaps shape `s2` with some offset `padding`.
   */
   overlapping: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    padding = 10
  ) => {
    if (t1 === "Circle" && t2 === "Circle")
      return constrDictSpecific.overlappingCircles([t1, s1], [t2, s2], padding);
    else {
      // TODO: Add other shapes using Minkowski penalties
      throw new Error(`${[t1, t2]} not supported for overlapping`);
    }
  },

  /**
   * Require that shape `s1` is tangent to shape `s2`.
   */
  tangentTo: (
    [t1, s1]: [string, any], 
    [t2, s2]: [string, any]
  ) => {
    if (t1 === "Circle" && t2 === "Circle")
      return constrDictSpecific.tangentCircles([t1, s1], [t2, s2]);
    else {
      // TODO: Add other shapes using Minkowski penalties
      throw new Error(`${[t1, t2]} not supported for tangentTo`);
    }
  },

  /**
   * Require that a shape `s1` contains another shape `s2`, based on the type of the shape, and with an optional `offset` between the sizes of the shapes (e.g. if `s1` should contain `s2` with margin `offset`).
   */
   contains: (
    [t1, s1]: [string, any],
    [t2, s2]: [string, any],
    offset: VarAD
  ) => {
    // TODO: Refactor
    if (t1 === "Circle" && t2 === "Circle") {
      const d = ops.vdist(shapeCenter([t1, s1]), shapeCenter([t2, s2]));
      const o = offset
        ? sub(sub(s1.r.contents, s2.r.contents), offset)
        : sub(s1.r.contents, s2.r.contents);
      const res = sub(d, o);
      return res;
    } else if (t1 === "Circle" && isRectlike(t2)) {
      const s2BBox = bboxFromShape(t2, s2);
      const d = ops.vdist(shapeCenter([t1, s1]), s2BBox.center);
      const textR = max(s2BBox.w, s2BBox.h);
      return add(sub(d, s1.r.contents), textR);
    } else if (isRectlike(t1) && t1 !== "Square" && t2 === "Circle") {
      // collect constants
      const halfW = mul( constOf(0.5), s1.w.contents ); // half rectangle width
      const halfH = mul( constOf(0.5), s1.h.contents ); // half rectangle height
      const [rx, ry] = s1.center.contents; // rectangle center
      const r = s2.r.contents; // circle radius
      const [cx, cy] = s2.center.contents; // circle center
      
      // Return maximum violation in either the x- or y-direction.
      // In each direction, the distance from the circle center (cx,cy) to
      // the rectangle center (rx,ry) must be no greater than the size of
      // the rectangle (w/h), minus the radius of the circle (r) and the
      // offset (o).  We can compute this violation via the function
      //    max( |cx-rx| - (w/2-r-o),
      //         |cy-ry| - (h/2-r-o) )
      const o = typeof(offset)!=='undefined'? offset : constOf(0.);
      return max( sub( absVal(sub(cx,rx)), sub(sub(halfW,r),o) ),
                  sub( absVal(sub(cy,ry)), sub(sub(halfH,r),o) ));
    } else if (t1 === "Square" && t2 === "Circle") {
      // dist (outerx, outery) (innerx, innery) - (0.5 * outer.side - inner.radius)
      const sq = s1.center.contents;
      const d = ops.vdist(sq, shapeCenter([t2, s2]));
      return sub(d, sub(mul(constOf(0.5), s1.side.contents), s2.r.contents));
    } else if (isRectlike(t1) && isRectlike(t2)) {
      const box1 = bboxFromShape(t1, s1);
      const box2 = bboxFromShape(t2, s2);

      // TODO: There are a lot of individual functions added -- should we optimize them individually with a 'fnAnd` construct?
      return add(
        constrDictSimple.contains1D(BBox.xRange(box1), BBox.xRange(box2)),
        constrDictSimple.contains1D(BBox.yRange(box1), BBox.yRange(box2))
      );
    } else if (t1 === "Square" && isLinelike(t2)) {
      const [[startX, startY], [endX, endY]] = linePts(s2);
      const [x, y] = shapeCenter([t1, s1]);

      const r = div(s1.side.contents, constOf(2.0));
      const f = constOf(0.75); // 0.25 padding
      //     (lx, ly) = ((x - side / 2) * 0.75, (y - side / 2) * 0.75)
      //     (rx, ry) = ((x + side / 2) * 0.75, (y + side / 2) * 0.75)
      // in inRange startX lx rx + inRange startY ly ry + inRange endX lx rx +
      //    inRange endY ly ry
      const [lx, ly] = [mul(sub(x, r), f), mul(sub(y, r), f)];
      const [rx, ry] = [mul(add(x, r), f), mul(add(y, r), f)];
      return addN([
        constrDictSimple.inRange(startX, lx, rx),
        constrDictSimple.inRange(startY, ly, ry),
        constrDictSimple.inRange(endX, lx, rx),
        constrDictSimple.inRange(endY, ly, ry),
      ]);
    } else throw new Error(`${[t1, t2]} not supported for contains`);
  },

  /**
   * Require that shape `s1` is smaller than `s2` with some relative offset `relativeOffset`.
   */
  smallerThan: ([t1, s1]: [string, any], [t2, s2]: [string, any], relativeOffset = 0.4) => {
    // s1 is smaller than s2
    const size1 = shapeSize([t1, s1]);
    const size2 = shapeSize([t2, s2]);
    const offset = mul(constOf(relativeOffset), size2);
    return sub(sub(size1, size2), offset);
  },

  /**
   * Require that the vector defined by `(q, p)` is perpendicular from the vector defined by `(r, p)`.
   */
  perpendicular: (q: VarAD[], p: VarAD[], r: VarAD[]): VarAD => {
    const v1 = ops.vsub(q, p);
    const v2 = ops.vsub(r, p);
    const dotProd = ops.vdot(v1, v2);
    return absVal(dotProd);
  },

  /**
   * Require that three points be collinear.
   */
  collinear: (c1: VarAD[], c2: VarAD[], c3: VarAD[]) => {
    const v1 = ops.vsub(c1, c2);
    const v2 = ops.vsub(c2, c3);
    const v3 = ops.vsub(c1, c3);

    // Use triangle inequality (v1 + v2 <= v3) to make sure v1, v2, and v3 don't form a triangle (and therefore must be collinear.)
    return max(
      constOf(0),
      sub(add(ops.vnorm(v1), ops.vnorm(v2)), ops.vnorm(v3))
    );
  },

  /**
   * Require that the `center`s of three shapes to be collinear. 
   * Does not enforce a specific ordering of points, instead it takes the arrangement of points that is most easily satisfiable.
   */
  collinearUnordered: (
    [t0, p0]: [string, any],
    [t1, p1]: [string, any],
    [t2, p2]: [string, any]
  ) => {
    if (every([p0, p1, p2].map((props) => props["center"]))) {
      const c1 = shapeCenter([t0, p0]);
      const c2 = shapeCenter([t1, p1]);
      const c3 = shapeCenter([t2, p2]);

      const v1 = ops.vnorm(ops.vsub(c1, c2));
      const v2 = ops.vnorm(ops.vsub(c2, c3));
      const v3 = ops.vnorm(ops.vsub(c1, c3));

      // Use triangle inequality (v1 + v2 <= v3) to make sure v1, v2, and v3 don't form a triangle (and therefore must be collinear.)
      return max(
        constOf(0),
        min(
          min(sub(add(v1, v2), v3), sub(add(v1, v3), v2)),
          sub(add(v2, v3), v1)
        )
      );
    } else {
      throw new Error("collinear: all input shapes need to have centers");
    }
  },

  /**
   * Require that a shape have a size greater than some constant minimum, based on the type of the shape.
   */
   minSize: ([shapeType, props]: [string, any], limit = 50) => {
    return sub(constOfIf(limit), shapeSize(props));
  },

  /**
   * Require that a shape have a size less than some constant maximum, based on the type of the shape.
   */
  maxSize: ([shapeType, props]: [string, any], limit: VarAD) => {
    return sub(shapeSize(props), constOfIf(limit));
  },

}

export const constrDict = Object.assign({}, constrDictSimple, constrDictSpecific, constrDictGeneral);
