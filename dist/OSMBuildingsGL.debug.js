(function(global) {
var earcut = (function() {

'use strict'

function earcut(points, returnIndices) {

    var outerNode = filterPoints(linkedList(points[0], true)),
        triangles = returnIndices ? {vertices: [], indices: []} : [];

    if (!outerNode) return triangles;

    var node, minX, minY, maxX, maxY, x, y, size, i,
        threshold = 80;

    for (i = 0; threshold >= 0 && i < points.length; i++) threshold -= points[i].length;

    // if the shape is not too simple, we'll use z-order curve hash later; calculate polygon bbox
    if (threshold < 0) {
        node = outerNode.next;
        minX = maxX = node.p[0];
        minY = maxY = node.p[1];
        do {
            x = node.p[0];
            y = node.p[1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            node = node.next;
        } while (node !== outerNode);

        // minX, minY and size are later used to transform coords into integers for z-order calculation
        size = Math.max(maxX - minX, maxY - minY);
    }

    if (points.length > 1) outerNode = eliminateHoles(points, outerNode);

    earcutLinked(outerNode, triangles, minX, minY, size);

    return triangles;
}

// create a circular doubly linked list from polygon points in the specified winding order
function linkedList(points, clockwise) {
    var sum = 0,
        len = points.length,
        i, j, p1, p2, last;

    // calculate original winding order of a polygon ring
    for (i = 0, j = len - 1; i < len; j = i++) {
        p1 = points[i];
        p2 = points[j];
        sum += (p2[0] - p1[0]) * (p1[1] + p2[1]);
    }

    // link points into circular doubly-linked list in the specified winding order
    if (clockwise === (sum > 0)) {
        for (i = 0; i < len; i++) last = insertNode(points[i], last);
    } else {
        for (i = len - 1; i >= 0; i--) last = insertNode(points[i], last);
    }

    return last;
}

// eliminate colinear or duplicate points
function filterPoints(start, end) {
    if (!end) end = start;

    var node = start,
        again;
    do {
        again = false;

        if (equals(node.p, node.next.p) || orient(node.prev.p, node.p, node.next.p) === 0) {

            // remove node
            node.prev.next = node.next;
            node.next.prev = node.prev;

            if (node.prevZ) node.prevZ.nextZ = node.nextZ;
            if (node.nextZ) node.nextZ.prevZ = node.prevZ;

            node = end = node.prev;

            if (node === node.next) return null;
            again = true;

        } else {
            node = node.next;
        }
    } while (again || node !== end);

    return end;
}

// main ear slicing loop which triangulates a polygon (given as a linked list)
function earcutLinked(ear, triangles, minX, minY, size, pass) {
    if (!ear) return;

    var indexed = triangles.vertices !== undefined;

    // interlink polygon nodes in z-order
    if (!pass && minX !== undefined) indexCurve(ear, minX, minY, size);

    var stop = ear,
        prev, next;

    // iterate through ears, slicing them one by one
    while (ear.prev !== ear.next) {
        prev = ear.prev;
        next = ear.next;

        if (isEar(ear, minX, minY, size)) {
            // cut off the triangle
            if (indexed) {
                addIndexedVertex(triangles, prev);
                addIndexedVertex(triangles, ear);
                addIndexedVertex(triangles, next);
            } else {
                triangles.push(prev.p);
                triangles.push(ear.p);
                triangles.push(next.p);
            }

            // remove ear node
            next.prev = prev;
            prev.next = next;

            if (ear.prevZ) ear.prevZ.nextZ = ear.nextZ;
            if (ear.nextZ) ear.nextZ.prevZ = ear.prevZ;

            // skipping the next vertice leads to less sliver triangles
            ear = next.next;
            stop = next.next;

            continue;
        }

        ear = next;

        // if we looped through the whole remaining polygon and can't find any more ears
        if (ear === stop) {
            // try filtering points and slicing again
            if (!pass) {
                earcutLinked(filterPoints(ear), triangles, minX, minY, size, 1);

            // if this didn't work, try curing all small self-intersections locally
            } else if (pass === 1) {
                ear = cureLocalIntersections(ear, triangles);
                earcutLinked(ear, triangles, minX, minY, size, 2);

            // as a last resort, try splitting the remaining polygon into two
            } else if (pass === 2) {
                splitEarcut(ear, triangles, minX, minY, size);
            }

            break;
        }
    }
}

function addIndexedVertex(triangles, node) {
    if (node.source) node = node.source;

    var i = node.index;
    if (i === null) {
        var dim = node.p.length;
        var vertices = triangles.vertices;
        node.index = i = vertices.length / dim;

        for (var d = 0; d < dim; d++) vertices.push(node.p[d]);
    }
    triangles.indices.push(i);
}

// check whether a polygon node forms a valid ear with adjacent nodes
function isEar(ear, minX, minY, size) {

    var a = ear.prev.p,
        b = ear.p,
        c = ear.next.p,

        ax = a[0], bx = b[0], cx = c[0],
        ay = a[1], by = b[1], cy = c[1],

        abd = ax * by - ay * bx,
        acd = ax * cy - ay * cx,
        cbd = cx * by - cy * bx,
        A = abd - acd - cbd;

    if (A <= 0) return false; // reflex, can't be an ear

    // now make sure we don't have other points inside the potential ear;
    // the code below is a bit verbose and repetitive but this is done for performance

    var cay = cy - ay,
        acx = ax - cx,
        aby = ay - by,
        bax = bx - ax,
        p, px, py, s, t, k, node;

    // if we use z-order curve hashing, iterate through the curve
    if (minX !== undefined) {

        // triangle bbox; min & max are calculated like this for speed
        var minTX = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx),
            minTY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy),
            maxTX = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx),
            maxTY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy),

            // z-order range for the current triangle bbox;
            minZ = zOrder(minTX, minTY, minX, minY, size),
            maxZ = zOrder(maxTX, maxTY, minX, minY, size);

        // first look for points inside the triangle in increasing z-order
        node = ear.nextZ;

        while (node && node.z <= maxZ) {
            p = node.p;
            node = node.nextZ;
            if (p === a || p === c) continue;

            px = p[0];
            py = p[1];

            s = cay * px + acx * py - acd;
            if (s >= 0) {
                t = aby * px + bax * py + abd;
                if (t >= 0) {
                    k = A - s - t;
                    if ((k >= 0) && ((s && t) || (s && k) || (t && k))) return false;
                }
            }
        }

        // then look for points in decreasing z-order
        node = ear.prevZ;

        while (node && node.z >= minZ) {
            p = node.p;
            node = node.prevZ;
            if (p === a || p === c) continue;

            px = p[0];
            py = p[1];

            s = cay * px + acx * py - acd;
            if (s >= 0) {
                t = aby * px + bax * py + abd;
                if (t >= 0) {
                    k = A - s - t;
                    if ((k >= 0) && ((s && t) || (s && k) || (t && k))) return false;
                }
            }
        }

    // if we don't use z-order curve hash, simply iterate through all other points
    } else {
        node = ear.next.next;

        while (node !== ear.prev) {
            p = node.p;
            node = node.next;

            px = p[0];
            py = p[1];

            s = cay * px + acx * py - acd;
            if (s >= 0) {
                t = aby * px + bax * py + abd;
                if (t >= 0) {
                    k = A - s - t;
                    if ((k >= 0) && ((s && t) || (s && k) || (t && k))) return false;
                }
            }
        }
    }

    return true;
}

// go through all polygon nodes and cure small local self-intersections
function cureLocalIntersections(start, triangles) {
    var indexed = !!triangles.vertices;

    var node = start;
    do {
        var a = node.prev,
            b = node.next.next;

        // a self-intersection where edge (v[i-1],v[i]) intersects (v[i+1],v[i+2])
        if (intersects(a.p, node.p, node.next.p, b.p) && locallyInside(a, b) && locallyInside(b, a)) {

            if (indexed) {
                addIndexedVertex(triangles, a);
                addIndexedVertex(triangles, node);
                addIndexedVertex(triangles, b);
            } else {
                triangles.push(a.p);
                triangles.push(node.p);
                triangles.push(b.p);
            }

            // remove two nodes involved
            a.next = b;
            b.prev = a;

            var az = node.prevZ,
                bz = node.nextZ && node.nextZ.nextZ;

            if (az) az.nextZ = bz;
            if (bz) bz.prevZ = az;

            node = start = b;
        }
        node = node.next;
    } while (node !== start);

    return node;
}

// try splitting polygon into two and triangulate them independently
function splitEarcut(start, triangles, minX, minY, size) {
    // look for a valid diagonal that divides the polygon into two
    var a = start;
    do {
        var b = a.next.next;
        while (b !== a.prev) {
            if (isValidDiagonal(a, b)) {
                // split the polygon in two by the diagonal
                var c = splitPolygon(a, b);

                // filter colinear points around the cuts
                a = filterPoints(a, a.next);
                c = filterPoints(c, c.next);

                // run earcut on each half
                earcutLinked(a, triangles, minX, minY, size);
                earcutLinked(c, triangles, minX, minY, size);
                return;
            }
            b = b.next;
        }
        a = a.next;
    } while (a !== start);
}

// link every hole into the outer loop, producing a single-ring polygon without holes
function eliminateHoles(points, outerNode) {
    var len = points.length;

    var queue = [];
    for (var i = 1; i < len; i++) {
        var list = filterPoints(linkedList(points[i], false));
        if (list) queue.push(getLeftmost(list));
    }
    queue.sort(compareX);

    // process holes from left to right
    for (i = 0; i < queue.length; i++) {
        eliminateHole(queue[i], outerNode);
        outerNode = filterPoints(outerNode, outerNode.next);
    }

    return outerNode;
}

// find a bridge between vertices that connects hole with an outer ring and and link it
function eliminateHole(holeNode, outerNode) {
    outerNode = findHoleBridge(holeNode, outerNode);
    if (outerNode) {
        var b = splitPolygon(outerNode, holeNode);
        filterPoints(b, b.next);
    }
}

// David Eberly's algorithm for finding a bridge between hole and outer polygon
function findHoleBridge(holeNode, outerNode) {
    var node = outerNode,
        p = holeNode.p,
        px = p[0],
        py = p[1],
        qMax = -Infinity,
        mNode, a, b;

    // find a segment intersected by a ray from the hole's leftmost point to the left;
    // segment's endpoint with lesser x will be potential connection point
    do {
        a = node.p;
        b = node.next.p;

        if (py <= a[1] && py >= b[1]) {
            var qx = a[0] + (py - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
            if (qx <= px && qx > qMax) {
                qMax = qx;
                mNode = a[0] < b[0] ? node : node.next;
            }
        }
        node = node.next;
    } while (node !== outerNode);

    if (!mNode) return null;

    // look for points strictly inside the triangle of hole point, segment intersection and endpoint;
    // if there are no points found, we have a valid connection;
    // otherwise choose the point of the minimum angle with the ray as connection point

    var bx = mNode.p[0],
        by = mNode.p[1],
        pbd = px * by - py * bx,
        pcd = px * py - py * qMax,
        cpy = py - py,
        pcx = px - qMax,
        pby = py - by,
        bpx = bx - px,
        A = pbd - pcd - (qMax * by - py * bx),
        sign = A <= 0 ? -1 : 1,
        stop = mNode,
        tanMin = Infinity,
        mx, my, amx, s, t, tan;

    node = mNode.next;

    while (node !== stop) {

        mx = node.p[0];
        my = node.p[1];
        amx = px - mx;

        if (amx >= 0 && mx >= bx) {
            s = (cpy * mx + pcx * my - pcd) * sign;
            if (s >= 0) {
                t = (pby * mx + bpx * my + pbd) * sign;

                if (t >= 0 && A * sign - s - t >= 0) {
                    tan = Math.abs(py - my) / amx; // tangential
                    if (tan < tanMin && locallyInside(node, holeNode)) {
                        mNode = node;
                        tanMin = tan;
                    }
                }
            }
        }

        node = node.next;
    }

    return mNode;
}

// interlink polygon nodes in z-order
function indexCurve(start, minX, minY, size) {
    var node = start;

    do {
        if (node.z === null) node.z = zOrder(node.p[0], node.p[1], minX, minY, size);
        node.prevZ = node.prev;
        node.nextZ = node.next;
        node = node.next;
    } while (node !== start);

    node.prevZ.nextZ = null;
    node.prevZ = null;

    sortLinked(node);
}

// Simon Tatham's linked list merge sort algorithm
// http://www.chiark.greenend.org.uk/~sgtatham/algorithms/listsort.html
function sortLinked(list) {
    var i, p, q, e, tail, numMerges, pSize, qSize,
        inSize = 1;

    while (true) {
        p = list;
        list = null;
        tail = null;
        numMerges = 0;

        while (p) {
            numMerges++;
            q = p;
            pSize = 0;
            for (i = 0; i < inSize; i++) {
                pSize++;
                q = q.nextZ;
                if (!q) break;
            }

            qSize = inSize;

            while (pSize > 0 || (qSize > 0 && q)) {

                if (pSize === 0) {
                    e = q;
                    q = q.nextZ;
                    qSize--;
                } else if (qSize === 0 || !q) {
                    e = p;
                    p = p.nextZ;
                    pSize--;
                } else if (p.z <= q.z) {
                    e = p;
                    p = p.nextZ;
                    pSize--;
                } else {
                    e = q;
                    q = q.nextZ;
                    qSize--;
                }

                if (tail) tail.nextZ = e;
                else list = e;

                e.prevZ = tail;
                tail = e;
            }

            p = q;
        }

        tail.nextZ = null;

        if (numMerges <= 1) return list;

        inSize *= 2;
    }
}

// z-order of a point given coords and size of the data bounding box
function zOrder(x, y, minX, minY, size) {
    // coords are transformed into (0..1000) integer range
    x = 1000 * (x - minX) / size;
    x = (x | (x << 8)) & 0x00FF00FF;
    x = (x | (x << 4)) & 0x0F0F0F0F;
    x = (x | (x << 2)) & 0x33333333;
    x = (x | (x << 1)) & 0x55555555;

    y = 1000 * (y - minY) / size;
    y = (y | (y << 8)) & 0x00FF00FF;
    y = (y | (y << 4)) & 0x0F0F0F0F;
    y = (y | (y << 2)) & 0x33333333;
    y = (y | (y << 1)) & 0x55555555;

    return x | (y << 1);
}

// find the leftmost node of a polygon ring
function getLeftmost(start) {
    var node = start,
        leftmost = start;
    do {
        if (node.p[0] < leftmost.p[0]) leftmost = node;
        node = node.next;
    } while (node !== start);

    return leftmost;
}

// check if a diagonal between two polygon nodes is valid (lies in polygon interior)
function isValidDiagonal(a, b) {
    return !intersectsPolygon(a, a.p, b.p) &&
           locallyInside(a, b) && locallyInside(b, a) &&
           middleInside(a, a.p, b.p);
}

// winding order of triangle formed by 3 given points
function orient(p, q, r) {
    var o = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
    return o > 0 ? 1 :
           o < 0 ? -1 : 0;
}

// check if two points are equal
function equals(p1, p2) {
    return p1[0] === p2[0] && p1[1] === p2[1];
}

// check if two segments intersect
function intersects(p1, q1, p2, q2) {
    return orient(p1, q1, p2) !== orient(p1, q1, q2) &&
           orient(p2, q2, p1) !== orient(p2, q2, q1);
}

// check if a polygon diagonal intersects any polygon segments
function intersectsPolygon(start, a, b) {
    var node = start;
    do {
        var p1 = node.p,
            p2 = node.next.p;

        if (p1 !== a && p2 !== a && p1 !== b && p2 !== b && intersects(p1, p2, a, b)) return true;

        node = node.next;
    } while (node !== start);

    return false;
}

// check if a polygon diagonal is locally inside the polygon
function locallyInside(a, b) {
    return orient(a.prev.p, a.p, a.next.p) === -1 ?
        orient(a.p, b.p, a.next.p) !== -1 && orient(a.p, a.prev.p, b.p) !== -1 :
        orient(a.p, b.p, a.prev.p) === -1 || orient(a.p, a.next.p, b.p) === -1;
}

// check if the middle point of a polygon diagonal is inside the polygon
function middleInside(start, a, b) {
    var node = start,
        inside = false,
        px = (a[0] + b[0]) / 2,
        py = (a[1] + b[1]) / 2;
    do {
        var p1 = node.p,
            p2 = node.next.p;

        if (((p1[1] > py) !== (p2[1] > py)) &&
            (px < (p2[0] - p1[0]) * (py - p1[1]) / (p2[1] - p1[1]) + p1[0])) inside = !inside;

        node = node.next;
    } while (node !== start);

    return inside;
}

function compareX(a, b) {
    return a.p[0] - b.p[0];
}

// link two polygon vertices with a bridge; if the vertices belong to the same ring, it splits polygon into two;
// if one belongs to the outer ring and another to a hole, it merges it into a single ring
function splitPolygon(a, b) {
    var a2 = new Node(a.p),
        b2 = new Node(b.p),
        an = a.next,
        bp = b.prev;

    a2.source = a;
    b2.source = b;

    a.next = b;
    b.prev = a;

    a2.next = an;
    an.prev = a2;

    b2.next = a2;
    a2.prev = b2;

    bp.next = b2;
    b2.prev = bp;

    return b2;
}

// create a node and optionally link it with previous one (in a circular doubly linked list)
function insertNode(point, last) {
    var node = new Node(point);

    if (!last) {
        node.prev = node;
        node.next = node;

    } else {
        node.next = last.next;
        node.prev = last;
        last.next.prev = node;
        last.next = node;
    }
    return node;
}

function Node(p) {
    // vertex coordinates
    this.p = p;

    // previous and next vertice nodes in a polygon ring
    this.prev = null;
    this.next = null;

    // z-order curve value
    this.z = null;

    // previous and next nodes in z-order
    this.prevZ = null;
    this.nextZ = null;

    // used for indexed output
    this.source = null;
    this.index = null;
}


return earcut;

}());

var Color = (function(window) {


var w3cColors = {
  aqua:'#00ffff',
  black:'#000000',
  blue:'#0000ff',
  fuchsia:'#ff00ff',
  gray:'#808080',
  grey:'#808080',
  green:'#008000',
  lime:'#00ff00',
  maroon:'#800000',
  navy:'#000080',
  olive:'#808000',
  orange:'#ffa500',
  purple:'#800080',
  red:'#ff0000',
  silver:'#c0c0c0',
  teal:'#008080',
  white:'#ffffff',
  yellow:'#ffff00'
};

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q-p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q-p) * (2/3 - t) * 6;
  return p;
}

function clamp(v, max) {
  return Math.min(max, Math.max(0, v));
}

var Color = function(h, s, l, a) {
  this.H = h;
  this.S = s;
  this.L = l;
  this.A = a;
};

/*
 * str can be in any of these:
 * #0099ff rgb(64, 128, 255) rgba(64, 128, 255, 0.5)
 */
Color.parse = function(str) {
  var
    r = 0, g = 0, b = 0, a = 1,
    m;

  str = (''+ str).toLowerCase();
  str = w3cColors[str] || str;

  if ((m = str.match(/^#(\w{2})(\w{2})(\w{2})$/))) {
    r = parseInt(m[1], 16);
    g = parseInt(m[2], 16);
    b = parseInt(m[3], 16);
  } else if ((m = str.match(/rgba?\((\d+)\D+(\d+)\D+(\d+)(\D+([\d.]+))?\)/))) {
    r = parseInt(m[1], 10);
    g = parseInt(m[2], 10);
    b = parseInt(m[3], 10);
    a = m[4] ? parseFloat(m[5]) : 1;
  } else {
    return;
  }

  return this.fromRGBA(r, g, b, a);
};

Color.fromRGBA = function(r, g, b, a) {
  if (typeof r === 'object') {
    g = r.g / 255;
    b = r.b / 255;
    a = (r.a !== undefined ? r.a : 1);
    r = r.r / 255;
  } else {
    r /= 255;
    g /= 255;
    b /= 255;
    a = (a !== undefined ? a : 1);
  }

  var
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    h, s, l = (max+min) / 2,
    d = max-min;

  if (!d) {
    h = s = 0; // achromatic
  } else {
    s = l > 0.5 ? d / (2-max-min) : d / (max+min);
    switch (max) {
      case r: h = (g-b) / d + (g < b ? 6 : 0); break;
      case g: h = (b-r) / d + 2; break;
      case b: h = (r-g) / d + 4; break;
    }
    h *= 60;
  }

  return new Color(h, s, l, a);
};

Color.prototype = {

  toRGBA: function(normalized) {
    var
      h = clamp(this.H, 360),
      s = clamp(this.S, 1),
      l = clamp(this.L, 1),
      rgba = { a: clamp(this.A, 1) };

    // achromatic
    if (s === 0) {
      rgba.r = l;
      rgba.g = l;
      rgba.b = l;
    } else {
      var
        q = l < 0.5 ? l * (1+s) : l + s - l*s,
        p = 2 * l-q;
        h /= 360;

      rgba.r = hue2rgb(p, q, h + 1/3);
      rgba.g = hue2rgb(p, q, h);
      rgba.b = hue2rgb(p, q, h - 1/3);
    }

    if (normalized) {
      return rgba;
    }

    return {
      r: Math.round(rgba.r*255),
      g: Math.round(rgba.g*255),
      b: Math.round(rgba.b*255),
      a: rgba.a
    };
  },

  toString: function() {
    var rgba = this.toRGBA();

    if (rgba.a === 1) {
      return '#' + ((1 <<24) + (rgba.r <<16) + (rgba.g <<8) + rgba.b).toString(16).slice(1, 7);
    }
    return 'rgba(' + [rgba.r, rgba.g, rgba.b, rgba.a.toFixed(2)].join(',') + ')';
  },

  hue: function(h) {
    return new Color(this.H*h, this.S, this.L, this.A);
  },

  saturation: function(s) {
    return new Color(this.H, this.S*s, this.L, this.A);
  },

  lightness: function(l) {
    return new Color(this.H, this.S, this.L*l, this.A);
  },

  alpha: function(a) {
    return new Color(this.H, this.S, this.L, this.A*a);
  }
};

return Color; }(this));
var glx = (function(global) {
var glx = {};

var GL;

glx.View = function(container, width, height) {

  var canvas = document.createElement('CANVAS');
  canvas.style.position = 'absolute';
  canvas.width = width;
  canvas.height = height;
  container.appendChild(canvas);

  var options = {
    antialias: true,
    depth: true,
    premultipliedAlpha: false
  };

  try {
    GL = canvas.getContext('webgl', options);
  } catch (ex) {}
  if (!GL) {
    try {
      GL = canvas.getContext('experimental-webgl', options);
    } catch (ex) {}
  }
  if (!GL) {
    throw new Error('WebGL not supported');
  }

  canvas.addEventListener('webglcontextlost', function(e) {
    console.warn('context lost');
  });

  canvas.addEventListener('webglcontextrestored', function(e) {
    console.warn('context restored');
  });

  //var ext = GL.getExtension("WEBGL_lose_context");
  //ext.loseContext();

  GL.viewport(0, 0, width, height);
  GL.cullFace(GL.BACK);
  GL.enable(GL.CULL_FACE);
  GL.enable(GL.DEPTH_TEST);
  GL.clearColor(0.5, 0.5, 0.5, 1);

  return GL;
};

glx.start = function(render) {
  return setInterval(function() {
    requestAnimationFrame(render);
  }, 17);
};

glx.stop = function(loop) {
  clearInterval(loop);
};

glx.destroy = function(GL) {
  GL.canvas.parentNode.removeChild(GL.canvas);
  GL.canvas = null;
};

//*****************************************************************************

if (typeof define === 'function') {
  define([], glx);
} else if (typeof exports === 'object') {
  module.exports = glx;
} else {
  global.glx = glx;
}


glx.util = {};

glx.util.nextPowerOf2 = function(n) {
  n--;
  n |= n >> 1;  // handle  2 bit numbers
  n |= n >> 2;  // handle  4 bit numbers
  n |= n >> 4;  // handle  8 bit numbers
  n |= n >> 8;  // handle 16 bit numbers
  n |= n >> 16; // handle 32 bit numbers
  n++;
  return n;
};

glx.util.calcNormal = function(ax, ay, az, bx, by, bz, cx, cy, cz) {
  var d1x = ax-bx;
  var d1y = ay-by;
  var d1z = az-bz;

  var d2x = bx-cx;
  var d2y = by-cy;
  var d2z = bz-cz;

  var nx = d1y*d2z - d1z*d2y;
  var ny = d1z*d2x - d1x*d2z;
  var nz = d1x*d2y - d1y*d2x;

  return this.calcUnit(nx, ny, nz);
};

glx.util.calcUnit = function(x, y, z) {
  var m = Math.sqrt(x*x + y*y + z*z);

  if (m === 0) {
    m = 0.00001;
  }

  return [x/m, y/m, z/m];
};


glx.Buffer = function(itemSize, data) {
  this.id = GL.createBuffer();
  this.itemSize = itemSize;
  this.numItems = data.length/itemSize;
  GL.bindBuffer(GL.ARRAY_BUFFER, this.id);
  GL.bufferData(GL.ARRAY_BUFFER, data, GL.STATIC_DRAW);
  data = null;
};

glx.Buffer.prototype = {
  enable: function() {
    GL.bindBuffer(GL.ARRAY_BUFFER, this.id);
  },

  destroy: function() {
    GL.deleteBuffer(this.id);
  }
};


glx.Framebuffer = function(width, height) {
  this.setSize(width, height);
};

glx.Framebuffer.prototype = {

  setSize: function(width, height) {
    this.frameBuffer = GL.createFramebuffer();
    GL.bindFramebuffer(GL.FRAMEBUFFER, this.frameBuffer);

    this.width  = width;
    this.height = height;
    var size = glx.util.nextPowerOf2(Math.max(this.width, this.height));

    this.renderBuffer = GL.createRenderbuffer();
    GL.bindRenderbuffer(GL.RENDERBUFFER, this.renderBuffer);
    GL.renderbufferStorage(GL.RENDERBUFFER, GL.DEPTH_COMPONENT16, size, size);

    if (this.renderTexture) {
      this.renderTexture.destroy();
    }

    this.renderTexture = new glx.texture.Data(size);

    GL.framebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, this.renderBuffer);
    GL.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, this.renderTexture.id, 0);

    if (GL.checkFramebufferStatus(GL.FRAMEBUFFER) !== GL.FRAMEBUFFER_COMPLETE) {
      throw new Error('This combination of framebuffer attachments does not work');
    }

    GL.bindRenderbuffer(GL.RENDERBUFFER, null);
    GL.bindFramebuffer(GL.FRAMEBUFFER, null);
  },

  enable: function() {
    GL.bindFramebuffer(GL.FRAMEBUFFER, this.frameBuffer);
    GL.bindRenderbuffer(GL.RENDERBUFFER, this.renderBuffer);
  },

  disable: function() {
    GL.bindFramebuffer(GL.FRAMEBUFFER, null);
    GL.bindRenderbuffer(GL.RENDERBUFFER, null);
  },

  getData: function() {
    var imageData = new Uint8Array(this.width*this.height*4);
    GL.readPixels(0, 0, this.width, this.height, GL.RGBA, GL.UNSIGNED_BYTE, imageData);
    return imageData;
  },

  destroy: function() {
    if (this.renderTexture) {
      this.renderTexture.destroy();
    }
  }
};


glx.Shader = function(config) {
  this.id = GL.createProgram();

  this.attach(GL.VERTEX_SHADER,   config.vertexShader);
  this.attach(GL.FRAGMENT_SHADER, config.fragmentShader);

  GL.linkProgram(this.id);

  if (!GL.getProgramParameter(this.id, GL.LINK_STATUS)) {
    throw new Error(GL.getProgramParameter(this.id, GL.VALIDATE_STATUS) +'\n'+ GL.getError());
  }

  this.attributeNames = config.attributes;
  this.uniformNames   = config.uniforms;
};

glx.Shader.prototype = {

  locateAttribute: function(name) {
    var loc = GL.getAttribLocation(this.id, name);
    if (loc < 0) {
      console.error('unable to locate attribute "'+ name +'" in shader');
      return;
    }
    GL.enableVertexAttribArray(loc);
    this.attributes[name] = loc;
  },

  locateUniform: function(name) {
    var loc = GL.getUniformLocation(this.id, name);
    if (loc < 0) {
      console.error('unable to locate uniform "'+ name +'" in shader');
      return;
    }
    this.uniforms[name] = loc;
  },

  attach: function(type, src) {
    var shader = GL.createShader(type);
    GL.shaderSource(shader, src);
    GL.compileShader(shader);

    if (!GL.getShaderParameter(shader, GL.COMPILE_STATUS)) {
      throw new Error(GL.getShaderInfoLog(shader));
    }

    GL.attachShader(this.id, shader);
  },

  enable: function() {
    GL.useProgram(this.id);

    var i;

    if (this.attributeNames) {
      this.attributes = {};
      for (i = 0; i < this.attributeNames.length; i++) {
        this.locateAttribute(this.attributeNames[i]);
      }
    }

    if (this.uniformNames) {
      this.uniforms = {};
      for (i = 0; i < this.uniformNames.length; i++) {
        this.locateUniform(this.uniformNames[i]);
      }
    }

    return this;
  },

  disable: function() {
    if (this.attributes) {
      for (var name in this.attributes) {
        GL.disableVertexAttribArray(this.attributes[name]);
      }
    }

    this.attributes = null;
    this.uniforms = null;
  },
  
  destroy: function() {}
};


glx.Matrix = function(data) {
  if (data) {
    this.data = new Float32Array(data);
  } else {
    this.identity();
  }
};

(function() {

  function rad(a) {
    return a * Math.PI/180;
  }

  function multiply(a, b) {
    var
      a00 = a[0],
      a01 = a[1],
      a02 = a[2],
      a03 = a[3],
      a10 = a[4],
      a11 = a[5],
      a12 = a[6],
      a13 = a[7],
      a20 = a[8],
      a21 = a[9],
      a22 = a[10],
      a23 = a[11],
      a30 = a[12],
      a31 = a[13],
      a32 = a[14],
      a33 = a[15],

      b00 = b[0],
      b01 = b[1],
      b02 = b[2],
      b03 = b[3],
      b10 = b[4],
      b11 = b[5],
      b12 = b[6],
      b13 = b[7],
      b20 = b[8],
      b21 = b[9],
      b22 = b[10],
      b23 = b[11],
      b30 = b[12],
      b31 = b[13],
      b32 = b[14],
      b33 = b[15];

    return new Float32Array([
      a00*b00 + a01*b10 + a02*b20 + a03*b30,
      a00*b01 + a01*b11 + a02*b21 + a03*b31,
      a00*b02 + a01*b12 + a02*b22 + a03*b32,
      a00*b03 + a01*b13 + a02*b23 + a03*b33,

      a10*b00 + a11*b10 + a12*b20 + a13*b30,
      a10*b01 + a11*b11 + a12*b21 + a13*b31,
      a10*b02 + a11*b12 + a12*b22 + a13*b32,
      a10*b03 + a11*b13 + a12*b23 + a13*b33,

      a20*b00 + a21*b10 + a22*b20 + a23*b30,
      a20*b01 + a21*b11 + a22*b21 + a23*b31,
      a20*b02 + a21*b12 + a22*b22 + a23*b32,
      a20*b03 + a21*b13 + a22*b23 + a23*b33,

      a30*b00 + a31*b10 + a32*b20 + a33*b30,
      a30*b01 + a31*b11 + a32*b21 + a33*b31,
      a30*b02 + a31*b12 + a32*b22 + a33*b32,
      a30*b03 + a31*b13 + a32*b23 + a33*b33
    ]);
  }

  glx.Matrix.prototype = {

    identity: function() {
      this.data = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
      ]);
      return this;
    },

    multiply: function(m) {
      this.data = multiply(this.data, m.data);
      return this;
    },

    translate: function(x, y, z) {
      this.data = multiply(this.data, [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, y, z, 1
      ]);
      return this;
    },

    rotateX: function(angle) {
      var a = rad(angle), c = Math.cos(a), s = Math.sin(a);
      this.data = multiply(this.data, [
        1, 0, 0, 0,
        0, c, s, 0,
        0, -s, c, 0,
        0, 0, 0, 1
      ]);
      return this;
    },

    rotateY: function(angle) {
      var a = rad(angle), c = Math.cos(a), s = Math.sin(a);
      this.data = multiply(this.data, [
        c, 0, -s, 0,
        0, 1, 0, 0,
        s, 0, c, 0,
        0, 0, 0, 1
      ]);
      return this;
    },

    rotateZ: function(angle) {
      var a = rad(angle), c = Math.cos(a), s = Math.sin(a);
      this.data = multiply(this.data, [
        c, -s, 0, 0,
        s, c, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
      ]);
      return this;
    },

    scale: function(x, y, z) {
      this.data = multiply(this.data, [
        x, 0, 0, 0,
        0, y, 0, 0,
        0, 0, z, 0,
        0, 0, 0, 1
      ]);
      return this;
    }
  };

  glx.Matrix.multiply = function(a, b) {
    return multiply(a.data, b.data);
  };

  glx.Matrix.Perspective = function(fov, aspect, near, far) {
    var f = 1/Math.tan(fov*(Math.PI/180)/2), nf = 1/(near - far);
    return new glx.Matrix([
      f/aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near)*nf, -1,
      0, 0, (2*far*near)*nf, 0
    ]);
  };

  glx.Matrix.invert3 = function(a) {
    var
      a00 = a[0], a01 = a[1], a02 = a[2],
      a04 = a[4], a05 = a[5], a06 = a[6],
      a08 = a[8], a09 = a[9], a10 = a[10],

      l =  a10 * a05 - a06 * a09,
      o = -a10 * a04 + a06 * a08,
      m =  a09 * a04 - a05 * a08,

      det = a00*l + a01*o + a02*m;

    if (!det) {
      return null;
    }

    det = 1.0/det;

    return [
      l                    * det,
      (-a10*a01 + a02*a09) * det,
      ( a06*a01 - a02*a05) * det,
      o                    * det,
      ( a10*a00 - a02*a08) * det,
      (-a06*a00 + a02*a04) * det,
      m                    * det,
      (-a09*a00 + a01*a08) * det,
      ( a05*a00 - a01*a04) * det
    ];
  };

  glx.Matrix.transpose = function(a) {
    return new Float32Array([
      a[0],
      a[3],
      a[6],
      a[1],
      a[4],
      a[7],
      a[2],
      a[5],
      a[8]
    ]);
  };

  // glx.Matrix.transform = function(x, y, z, m) {
  //   var X = x*m[0] + y*m[4] + z*m[8]  + m[12];
  //   var Y = x*m[1] + y*m[5] + z*m[9]  + m[13];
  //   var Z = x*m[2] + y*m[6] + z*m[10] + m[14];
  //   var W = x*m[3] + y*m[7] + z*m[11] + m[15];
  //   return {
  //     x: (X/W +1) / 2,
  //     y: (Y/W +1) / 2
  //   };
  // };

  glx.Matrix.transform = function(m) {
    var X = m[12];
    var Y = m[13];
    var Z = m[14];
    var W = m[15];
    return {
      x: (X/W +1) / 2,
      y: (Y/W +1) / 2,
      z: (Z/W +1) / 2
    };
  };

}());


glx.texture = {};


glx.texture.Image = function(src, callback) {
  this.id = GL.createTexture();
  GL.bindTexture(GL.TEXTURE_2D, this.id);

  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_NEAREST);
  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
//GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
//GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);

  GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
  GL.bindTexture(GL.TEXTURE_2D, null);

  var image = new Image();

  image.crossOrigin = '*';

  image.onload = function() {
    // TODO: do this only once
    var maxTexSize = GL.getParameter(GL.MAX_TEXTURE_SIZE);
    if (image.width > maxTexSize || image.height > maxTexSize) {
      var w = maxTexSize, h = maxTexSize;
      var ratio = image.width/image.height;
      // TODO: if other dimension doesn't fit to POT after resize, there is still trouble
      if (ratio < 1) {
        w = Math.round(h*ratio);
      } else {
        h = Math.round(w/ratio);
      }

      var canvas = document.createElement('CANVAS');
      canvas.width  = w;
      canvas.height = h;

      var context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image = canvas;
    }

    if (!this.id) {
      image = null;
    } else {
      GL.bindTexture(GL.TEXTURE_2D, this.id);
      GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, image);
      GL.generateMipmap(GL.TEXTURE_2D);
      GL.bindTexture(GL.TEXTURE_2D, null);
    }

    if (callback) {
      callback(image);
    }

  }.bind(this);

  image.onerror = function() {
    if (callback) {
      callback();
    }
  };

  image.src = src;
};

glx.texture.Image.prototype = {

  enable: function(index) {
    if (!this.id) {
      return;
    }
    GL.bindTexture(GL.TEXTURE_2D, this.id);
    GL.activeTexture(GL.TEXTURE0 + (index || 0));
  },

  disable: function() {
    GL.bindTexture(GL.TEXTURE_2D, null);
  },

  destroy: function() {
    GL.bindTexture(GL.TEXTURE_2D, null);
    GL.deleteTexture(this.id);
    this.id = null;
  }
};


glx.texture.Data = function(size, data, options) {
  //options = options || {};

  this.id = GL.createTexture();
  GL.bindTexture(GL.TEXTURE_2D, this.id);

  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
  GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);

  //if (options.flipY) {
  //  GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
  //}

  var bytes = null;

  if (data) {
    var length = size*size*4;
    bytes = new Uint8Array(length);
    bytes.set(data.subarray(0, length));
  }

  GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, size, size, 0, GL.RGBA, GL.UNSIGNED_BYTE, bytes);
  GL.bindTexture(GL.TEXTURE_2D, null);
};

glx.texture.Data.prototype = {

  enable: function(index) {
    GL.bindTexture(GL.TEXTURE_2D, this.id);
    GL.activeTexture(GL.TEXTURE0 + (index || 0));
  },

  disable: function() {
    GL.bindTexture(GL.TEXTURE_2D, null);
  },

  destroy: function() {
    GL.bindTexture(GL.TEXTURE_2D, null);
    GL.deleteTexture(this.id);
  }
};


glx.mesh = {};

glx.mesh.addQuad = function(data, a, b, c, d, color) {
  this.addTriangle(data, a, b, c, color);
  this.addTriangle(data, c, d, a, color);
};

glx.mesh.addTriangle = function(data, a, b, c, color) {
  data.vertices.push(
    a[0], a[1], a[2],
    b[0], b[1], b[2],
    c[0], c[1], c[2]
  );

  var n = glx.util.calcNormal(
    a[0], a[1], a[2],
    b[0], b[1], b[2],
    c[0], c[1], c[2]
  );

  data.normals.push(
    n[0], n[1], n[2],
    n[0], n[1], n[2],
    n[0], n[1], n[2]
  );

  data.colors.push(
    color[0], color[1], color[2], color[3],
    color[0], color[1], color[2], color[3],
    color[0], color[1], color[2], color[3]
  );
};


glx.mesh.Triangle = function(size, color) {

  var data = {
    vertices: [],
    normals: [],
    colors: []
  };

  var a = [-size/2, -size/2, 0];
  var b = [ size/2, -size/2, 0];
  var c = [ size/2,  size/2, 0];

  glx.mesh.addTriangle(data, a, b, c, color);

  this.vertexBuffer = new glx.Buffer(3, new Float32Array(data.vertices));
  this.normalBuffer = new glx.Buffer(3, new Float32Array(data.normals));
  this.colorBuffer  = new glx.Buffer(4, new Float32Array(data.colors));

 	this.transform = new glx.Matrix();
};


glx.mesh.Plane = function(size, color) {

  var data = {
    vertices: [],
    normals: [],
    colors: []
  };

  var a = [-size/2, -size/2, 0];
  var b = [ size/2, -size/2, 0];
  var c = [ size/2,  size/2, 0];
  var d = [-size/2,  size/2, 0];

  glx.mesh.addQuad(data, a, b, c, d, color);

  this.vertexBuffer = new glx.Buffer(3, new Float32Array(data.vertices));
  this.normalBuffer = new glx.Buffer(3, new Float32Array(data.normals));
  this.colorBuffer  = new glx.Buffer(4, new Float32Array(data.colors));

 	this.transform = new glx.Matrix();
};


glx.mesh.Cube = function(size, color) {

  var data = {
    vertices: [],
    normals: [],
    colors: []
  };

  var a = [-size/2, -size/2, -size/2];
  var b = [ size/2, -size/2, -size/2];
  var c = [ size/2,  size/2, -size/2];
  var d = [-size/2,  size/2, -size/2];

  var A = [-size/2, -size/2, size/2];
  var B = [ size/2, -size/2, size/2];
  var C = [ size/2,  size/2, size/2];
  var D = [-size/2,  size/2, size/2];

  glx.mesh.addQuad(data, a, b, c, d, color);
  glx.mesh.addQuad(data, A, B, C, D, color);
  glx.mesh.addQuad(data, a, b, B, A, color);
  glx.mesh.addQuad(data, b, c, C, B, color);
  glx.mesh.addQuad(data, c, d, D, C, color);
  glx.mesh.addQuad(data, d, a, A, D, color);

  this.vertexBuffer = new glx.Buffer(3, new Float32Array(data.vertices));
  this.normalBuffer = new glx.Buffer(3, new Float32Array(data.normals));
  this.colorBuffer  = new glx.Buffer(4, new Float32Array(data.colors));

  this.transform = new glx.Matrix();
};

return glx;
}(this));
var GL;
var WIDTH = 0, HEIGHT = 0;

var OSMBuildingsGL = function(containerId, options) {
  options = options || {};

  var container = document.getElementById(containerId);
  container.classList.add('osmb-container');

  WIDTH = container.offsetWidth;
  HEIGHT = container.offsetHeight;
  GL = new glx.View(container, WIDTH, HEIGHT);

  Renderer.start({
    fogColor: options.fogColor,
    showBackfaces: options.showBackfaces
  });

  Interaction.initShader();

  Map.init(options);
  Events.init(container);

  this.setDisabled(options.disabled);
  if (options.style) {
    this.setStyle(options.style);
  }

  TileGrid.setSource(options.tileSource);
  DataGrid.setSource(options.dataSource, options.dataKey || DATA_KEY);

  if (options.attribution !== null && options.attribution !== false && options.attribution !== '') {
    var attribution = document.createElement('DIV');
    attribution.className = 'osmb-attribution';
    attribution.innerHTML = options.attribution || OSMBuildingsGL.ATTRIBUTION;
    container.appendChild(attribution);
  }
};

OSMBuildingsGL.VERSION = '0.1.8';
OSMBuildingsGL.ATTRIBUTION = '© OSM Buildings (http://osmbuildings.org)';
OSMBuildingsGL.ATTRIBUTION_HTML = '&copy; <a href="http://osmbuildings.org">OSM Buildings</a>';

OSMBuildingsGL.prototype = {

  setStyle: function(style) {
    var color = style.color || style.wallColor;
    if (color) {
      // TODO: move this to Renderer
      DEFAULT_COLOR = Color.parse(color).toRGBA(true);
    }
    return this;
  },

  addOBJ: function(url, position, options) {
    return new mesh.OBJ(url, position, options);
  },

  addGeoJSON: function(url, options) {
    return new mesh.GeoJSON(url, options);
  },

  on: function(type, fn) {
    Events.on(type, fn);
    return this;
  },

  off: function(type, fn) {
    Events.off(type, fn);
    return this;
  },

  setDisabled: function(flag) {
    Events.setDisabled(flag);
    return this;
  },

  isDisabled: function() {
    return Events.isDisabled();
  },

  setZoom: function(zoom) {
    Map.setZoom(zoom);
    return this;
  },

  getZoom: function() {
    return Map.zoom;
  },

  setPosition: function(position) {
    Map.setPosition(position);
    return this;
  },

  getPosition: function() {
    return Map.position;
  },

  getBounds: function() {
    var mapBounds = Map.bounds;
    var worldSize = TILE_SIZE*Math.pow(2, Map.zoom);
    var nw = unproject(mapBounds.minX, mapBounds.maxY, worldSize);
    var se = unproject(mapBounds.maxX, mapBounds.minY, worldSize);
    return {
      n: nw.latitude,
      w: nw.longitude,
      s: se.latitude,
      e: se.longitude
    };
  },

  setSize: function(size) {
    if (size.width !== WIDTH || size.height !== HEIGHT) {
      GL.canvas.width = WIDTH = size.width;
      GL.canvas.height = HEIGHT = size.height;
      Events.emit('resize');
    }
    return this;
  },

  getSize: function() {
    return { width: WIDTH, height: HEIGHT };
  },

  setRotation: function(rotation) {
    Map.setRotation(rotation);
    return this;
  },

  getRotation: function() {
    return Map.rotation;
  },

  setTilt: function(tilt) {
    Map.setTilt(tilt);
    return this;
  },

  getTilt: function() {
    return Map.tilt;
  },

  transform: function(latitude, longitude, elevation) {
    var pos = project(latitude, longitude, TILE_SIZE*Math.pow(2, Map.zoom));
    var mapCenter = Map.center;

    var vpMatrix = new glx.Matrix(glx.Matrix.multiply(Map.transform, Renderer.perspective));

    var scale = 1/Math.pow(2, 16 - Map.zoom);
    var mMatrix = new glx.Matrix()
      .translate(0, 0, elevation)
      .scale(scale, scale, scale*0.7)
      .translate(pos.x - mapCenter.x, pos.y - mapCenter.y, 0);

    var mvp = glx.Matrix.multiply(mMatrix, vpMatrix);

    var t = glx.Matrix.transform(mvp);
    return { x: t.x*WIDTH, y: HEIGHT - t.y*HEIGHT };
  },

  highlight: function(id, color) {
    Buildings.highlightColor = color ? Color.parse(color).toRGBA(true) : null;
    Buildings.highlightID = Interaction.idToColor(id);
  },

  destroy: function() {
    glx.destroy(GL);
    Renderer.destroy();
    TileGrid.destroy();
    DataGrid.destroy();
  }
};

//*****************************************************************************

if (typeof global.define === 'function') {
  global.define([], OSMBuildingsGL);
} else if (typeof global.exports === 'object') {
  global.module.exports = OSMBuildingsGL;
} else {
  global.OSMBuildingsGL = OSMBuildingsGL;
}


var Map = {};

(function() {

  function updateBounds() {
    var
      center = Map.center,
      halfWidth  = WIDTH/2,
      halfHeight = HEIGHT/2;

    Map.bounds = {
      maxY: center.y + halfHeight,
      minX: center.x - halfWidth,
      minY: center.y - halfHeight,
      maxX: center.x + halfWidth
    };
  }

  //***************************************************************************

  Map.center = { x:0, y:0 };
  Map.zoom = 0;
  Map.transform = new glx.Matrix(); // there are very early actions that rely on an existing Map transform

  Map.init = function(options) {
    this.minZoom = parseFloat(options.minZoom) || 10;
    this.maxZoom = parseFloat(options.maxZoom) || 20;

    if (this.maxZoom<this.minZoom) {
      this.maxZoom = this.minZoom;
    }

    var state = State.load();
    this.setPosition(state.position || options.position || { latitude: 52.52000, longitude: 13.41000 });
    this.setZoom(state.zoom || options.zoom || this.minZoom);
    this.setRotation(state.rotation || options.rotation || 0);
    this.setTilt(state.tilt || options.tilt || 0);

    Events.on('resize', updateBounds);

    if (options.state) {
      State.save(Map);

      Events.on('change', function() {
        State.save(Map);
      });
    }
  };

  Map.setZoom = function(zoom, e) {
    zoom = clamp(parseFloat(zoom), this.minZoom, this.maxZoom);

    if (this.zoom !== zoom) {
      var ratio = Math.pow(2, zoom-this.zoom);
      this.zoom = zoom;
      if (!e) {
        this.center.x *= ratio;
        this.center.y *= ratio;
      } else {
        var dx = WIDTH/2  - e.clientX;
        var dy = HEIGHT/2 - e.clientY;
        this.center.x -= dx;
        this.center.y -= dy;
        this.center.x *= ratio;
        this.center.y *= ratio;
        this.center.x += dx;
        this.center.y += dy;
      }
      updateBounds();
      Events.emit('change');
    }
  };

  Map.setPosition = function(pos) {
    var latitude  = clamp(parseFloat(pos.latitude), -90, 90);
    var longitude = clamp(parseFloat(pos.longitude), -180, 180);
    var center = project(latitude, longitude, TILE_SIZE*Math.pow(2, this.zoom));
    this.setCenter(center);
  };

  Map.setCenter = function(center) {
    if (this.center.x !== center.x || this.center.y !== center.y) {
      this.center = center;
      this.position = unproject(center.x, center.y, TILE_SIZE*Math.pow(2, this.zoom));
      updateBounds();
      Events.emit('change');
    }
  };

  Map.setRotation = function(rotation) {
    rotation = parseFloat(rotation)%360;
    if (this.rotation !== rotation) {
      this.rotation = rotation;
      updateBounds();
      Events.emit('change');
    }
  };

  Map.setTilt = function(tilt) {
    tilt = clamp(parseFloat(tilt), 0, 60);
    if (this.tilt !== tilt) {
      this.tilt = tilt;
      updateBounds();
      Events.emit('change');
    }
  };

  Map.destroy = function() {};

}());


var Events = {};

(function() {

  var
    listeners = {},

    prevX = 0, prevY = 0,
    startX = 0, startY  = 0,
    startZoom = 0,
    prevRotation = 0,
    prevTilt = 0,

    isDisabled = false,
    pointerIsDown = false,
    resizeTimer;

  //***************************************************************************
  //***************************************************************************

  function onDoubleClick(e) {
    if (isDisabled) {
      return;
    }
    cancelEvent(e);
    Map.setZoom(Map.zoom + 1, e);
  }

  function onMouseDown(e) {
    if (isDisabled || e.button > 1) {
      return;
    }

    cancelEvent(e);

    startZoom = Map.zoom;
    prevRotation = Map.rotation;
    prevTilt = Map.tilt;

    startX = prevX = e.clientX;
    startY = prevY = e.clientY;

    pointerIsDown = true;

    Interaction.getTargetID(e.clientX, e.clientY, function(targetID) {
      var payload = { x: e.clientX, y: e.clientY };
      if (targetID) {
        payload.target = { id: targetID };
      }
      Events.emit('pointerdown', payload);
    });
  }

  function onMouseMove(e) {
    if (isDisabled) {
      return;
    }

    if (pointerIsDown) {
      if (e.button === 0 && !e.altKey) {
        moveMap(e);
      } else {
        rotateMap(e);
      }

      prevX = e.clientX;
      prevY = e.clientY;
    }

    Interaction.getTargetID(e.clientX, e.clientY, function(targetID) {
      var payload = { x: e.clientX, y: e.clientY };
      if (targetID) {
        payload.target = { id: targetID };
      }
      Events.emit('pointermove', payload);
    });
  }

  function onMouseUp(e) {
    if (isDisabled) {
      return;
    }

    // prevents clicks on other page elements
    if (!pointerIsDown) {
      return;
    }

    if (e.button === 0 && !e.altKey) {
      if (Math.abs(e.clientX-startX) > 5 || Math.abs(e.clientY-startY) > 5) {
        moveMap(e);
      }
    } else {
      rotateMap(e);
    }

    pointerIsDown = false;

    Interaction.getTargetID(e.clientX, e.clientY, function(targetID) {
      var payload = { x: e.clientX, y: e.clientY };
      if (targetID) {
        payload.target = { id: targetID };
      }
      Events.emit('pointerup', payload);
    });
  }

  function onMouseWheel(e) {
    if (isDisabled) {
      return;
    }
    cancelEvent(e);
    var delta = 0;
    if (e.wheelDeltaY) {
      delta = e.wheelDeltaY;
    } else if (e.wheelDelta) {
      delta = e.wheelDelta;
    } else if (e.detail) {
      delta = -e.detail;
    }

    var adjust = 0.2*(delta>0 ? 1 : delta<0 ? -1 : 0);
    Map.setZoom(Map.zoom + adjust, e);
  }

  //***************************************************************************
  //***************************************************************************

  function onTouchStart(e) {
    if (isDisabled) {
      return;
    }

    cancelEvent(e);

    startZoom = Map.zoom;
    prevRotation = Map.rotation;
    prevTilt = Map.tilt;

    if (e.touches.length > 1) {
      e = e.touches[0];
    }

    startX = prevX = e.clientX;
    startY = prevY = e.clientY;

    var payload = { x: e.clientX, y: e.clientY };
    if (targetID) {
      payload.target = { id: targetID };
    }
    Events.emit('pointerdown', payload);
  }

  function onTouchMove(e) {
    if (isDisabled) {
      return;
    }

    if (e.touches.length > 1) {
      e = e.touches[0];
    }

    moveMap(e);

    prevX = e.clientX;
    prevY = e.clientY;

    var payload = { x: e.clientX, y: e.clientY };
    if (targetID) {
      payload.target = { id: targetID };
    }
    Events.emit('pointermove', payload);
  }

  function onTouchEnd(e) {
    if (isDisabled) {
      return;
    }

    if (e.touches.length > 1) {
      e = e.touches[0];
    }

    if (Math.abs(e.clientX-startX) > 5 || Math.abs(e.clientY-startY) > 5) {
      moveMap(e);
    }

    var payload = { x: e.clientX, y: e.clientY };
    if (targetID) {
      payload.target = { id: targetID };
    }
    Events.emit('pointerup', payload);
  }

  function onGestureChange(e) {
    if (isDisabled) {
      return;
    }
    cancelEvent(e);
    Map.setZoom(startZoom + (e.scale - 1));
    Map.setRotation(prevRotation - e.rotation);
//  Map.setTilt(prevTilt ...);
  }

  //***************************************************************************

  function moveMap(e) {
    var dx = e.clientX - prevX;
    var dy = e.clientY - prevY;
    var r = rotatePoint(dx, dy, Map.rotation*Math.PI/180);
    Map.setCenter({ x:Map.center.x-r.x, y:Map.center.y-r.y });
  }

  function rotateMap(e) {
    prevRotation += (e.clientX - prevX)*(360/innerWidth);
    prevTilt -= (e.clientY - prevY)*(360/innerHeight);
    Map.setRotation(prevRotation);
    Map.setTilt(prevTilt);
  }

  //***************************************************************************

  Events.init = function(container) {
    if ('ontouchstart' in global) {
      addListener(container, 'touchstart', onTouchStart);
      addListener(document, 'touchmove', onTouchMove);
      addListener(document, 'touchend', onTouchEnd);
      addListener(container, 'gesturechange', onGestureChange);
    } else {
      addListener(container, 'mousedown', onMouseDown);
      addListener(document, 'mousemove', onMouseMove);
      addListener(document, 'mouseup', onMouseUp);
      addListener(container, 'dblclick', onDoubleClick);
      addListener(container, 'mousewheel', onMouseWheel);
      addListener(container, 'DOMMouseScroll', onMouseWheel);
    }

    addListener(global, 'resize', function() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function() {
        // some duplication with index.js
        if (container.offsetWidth !== WIDTH || container.offsetHeight !== HEIGHT) {
          GL.canvas.width  = WIDTH  = container.offsetWidth;
          GL.canvas.height = HEIGHT = container.offsetHeight;
          Events.emit('resize');
        }
      }, 250);
    });
  };

  Events.on = function(type, fn) {
    if (!listeners[type]) {
     listeners[type] = [];
    }
    listeners[type].push(fn);
  };

  Events.off = function(type, fn) {};

  Events.emit = function(type, payload) {
    if (!listeners[type]) {
      return;
    }
    for (var i = 0, il = listeners[type].length; i<il; i++) {
      listeners[type][i](payload);
    }
  };

  Events.setDisabled = function(flag) {
    isDisabled = !!flag;
  };

  Events.isDisabled = function() {
    return !!isDisabled;
  };

  Events.destroy = function() {
    listeners = null;
  };
}());

//*****************************************************************************

function addListener(target, type, fn) {
  target.addEventListener(type, fn, false);
}

function removeListener(target, type, fn) {
  target.removeEventListener(type, fn, false);
}

function cancelEvent(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  if (e.stopPropagation) {
    e.stopPropagation();
  }
  e.returnValue = false;
}


var Activity = {};

(function() {

  var count = 0;
  var timer;

  Activity.setBusy = function(msg) {
    //if (msg) {
    //  console.log('setBusy', msg, count);
    //}

    if (!count) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      } else {
        Events.emit('busy');
      }
    }
    count++;
  };

  Activity.setIdle = function(msg) {
    if (!count) {
      return;
    }

    count--;
    if (!count) {
      timer = setTimeout(function() {
        timer = null;
        Events.emit('idle');
      }, 10);
    }

    //if (msg) {
    //  console.log('setIdle', msg, count);
    //}
  };

  Activity.isBusy = function() {
    return !!count;
  };

}());


var State = {};

(function() {

  function save(map) {
    if (!history.replaceState) {
      return;
    }

    var params = [];
    var position = map.position;
    params.push('lat=' + position.latitude.toFixed(5));
    params.push('lon=' + position.longitude.toFixed(5));
    params.push('zoom=' + map.zoom.toFixed(1));
    params.push('tilt=' + map.tilt.toFixed(1));
    params.push('rotation=' + map.rotation.toFixed(1));
    history.replaceState({}, '', '?'+ params.join('&'));
  }

  State.load = function() {
    var state = {};
    var query = location.search;
    if (query) {
      var params = {};
      query = query.substring(1).replace( /(?:^|&)([^&=]*)=?([^&]*)/g, function ($0, $1, $2) {
        if ($1) {
          params[$1] = $2;
        }
      });

      var res = {};
      if (params.lat !== undefined && params.lon !== undefined) {
        state.position = { latitude:parseFloat(params.lat), longitude:parseFloat(params.lon) };
      }
      if (params.zoom !== undefined) {
        state.zoom = parseFloat(params.zoom);
      }
      if (params.rotation !== undefined) {
        state.rotation = parseFloat(params.rotation);
      }
      if (params.tilt !== undefined) {
        state.tilt = parseFloat(params.tilt);
      }
    }
    return state;
  };

  var timer;
  State.save = function(map) {
    clearTimeout(timer);
    timer = setTimeout(function() {
      save(map);
    }, 1000);
  };

}());


var PI = Math.PI;

var MIN_ZOOM = 15;

var TILE_SIZE = 256;

var DATA_KEY = 'anonymous';
var DATA_SRC = 'http://{s}.data.osmbuildings.org/0.2/{k}/tile/{z}/{x}/{y}.json';

var DEFAULT_HEIGHT = 10;

var DEFAULT_COLOR = Color.parse('rgb(220, 210, 200)').toRGBA(true);
var DEFAULT_HIGHLIGHT_COLOR = Color.parse('#f08000').toRGBA(true);

var FOG_RADIUS = 7500;
var FOG_COLOR = Color.parse('#f0f8ff').toRGBA(true);

var document = global.document;

var EARTH_RADIUS = 6378137;
var EARTH_CIRCUMFERENCE = EARTH_RADIUS*Math.PI*2;


var Request = {};

(function() {

  var queue = {};

  function load(url, callback) {
    if (queue[url]) {
      return queue[url];
    }

    var req = new XMLHttpRequest();

    req.onreadystatechange = function() {
      if (req.readyState !== 4) {
        return;
      }

      delete queue[url];

      if (!req.status || req.status<200 || req.status>299) {
        return;
      }

      callback(req);
    };

    queue[url] = req;
    req.open('GET', url);
    req.send(null);

    return {
      abort: function() {
        if (queue[url]) {
          req.abort();
          delete queue[url];
        }
      }
    };
  }

  //***************************************************************************

  Request.getText = function(url, callback) {
    return load(url, function(res) {
      if (res.responseText !== undefined) {
        callback(res.responseText);
      }
    });
  };

  Request.getXML = function(url, callback) {
    return load(url, function(res) {
      if (res.responseXML !== undefined) {
        callback(res.responseXML);
      }
    });
  };

  Request.getJSON = function(url, callback) {
    return load(url, function(res) {
      if (res.responseText) {
        var json;
        try {
          json = JSON.parse(res.responseText);
        } catch(ex) {
          console.warn('Could not parse JSON from '+ url +'\n'+ ex.message);
        }
        callback(json);
      }
    });
  };

  Request.abortAll = function() {
    for (var url in queue) {
      queue[url].abort();
    }
    queue = {};
  };

  Request.destroy = function() {
    this.abortAll();
    queue = null;
  };

}());


function clamp(value, min, max) {
  return Math.min(max, Math.max(value, min));
}

function normalize(value, min, max) {
  var range = max-min;
  return clamp((value-min)/range, 0, 1);
}

function adjust(inValue, style, inProperty, outProperty) {
  var min = style.min, max = style.max;
  var normalized = normalize(inValue, min[inProperty], max[inProperty]);
  return min[outProperty] + (max[outProperty]-min[outProperty]) * normalized;
}

function project(latitude, longitude, worldSize) {
  var
    x = longitude/360 + 0.5,
    y = Math.min(1, Math.max(0, 0.5 - (Math.log(Math.tan((Math.PI/4) + (Math.PI/2)*latitude/180)) / Math.PI) / 2));
  return { x: x*worldSize, y: y*worldSize };
}

function unproject(x, y, worldSize) {
  x /= worldSize;
  y /= worldSize;
  return {
    latitude: (2 * Math.atan(Math.exp(Math.PI * (1 - 2*y))) - Math.PI/2) * (180/Math.PI),
    longitude: x*360 - 180
  };
}

function pattern(str, param) {
  return str.replace(/\{(\w+)\}/g, function(tag, key) {
    return param[key] || tag;
  });
}

function relax(callback, startIndex, dataLength, chunkSize, delay) {
  chunkSize = chunkSize || 1000;
  delay = delay || 1;

  var endIndex = startIndex + Math.min((dataLength-startIndex), chunkSize);

  if (startIndex === endIndex) {
    return;
  }

  callback(startIndex, endIndex);

  if (startIndex < dataLength) {
    setTimeout(function() {
      relax(callback, endIndex, dataLength, chunkSize, delay);
    }, delay);
  }
}

var SHADERS = {"interaction":{"vertex":"#ifdef GL_ES\n  precision mediump float;\n#endif\nattribute vec4 aPosition;\nattribute vec3 aColor;\nuniform mat4 uMMatrix;\nuniform mat4 uMatrix;\nuniform float uFogRadius;\nvarying vec4 vColor;\nvoid main() {\n  gl_Position = uMatrix * aPosition;\n  vec4 mPosition = vec4(uMMatrix * aPosition);\n  float distance = length(mPosition);\n  if (distance > uFogRadius) {\n    vColor = vec4(0.0, 0.0, 0.0, 0.0);\n  } else {\n    vColor = vec4(aColor, 1.0);\n  }\n}\n","fragment":"#ifdef GL_ES\n  precision mediump float;\n#endif\nvarying vec4 vColor;\nvoid main() {\n  gl_FragColor = vColor;\n}\n"},"depth":{"vertex":"#ifdef GL_ES\n  precision mediump float;\n#endif\nattribute vec4 aPosition;\nuniform mat4 uMatrix;\nvarying vec4 vPosition;\nvoid main() {\n//  if (aHidden == 1.0) {\n//    gl_Position = vec4(0.0);\n//    vPosition = vec4(0.0);\n//  }\n  gl_Position = uMatrix * aPosition;\n  vPosition = aPosition;\n}\n","fragment":"#ifdef GL_ES\n  precision mediump float;\n#endif\nvarying vec4 vPosition;\nvoid main() {\n\tgl_FragColor = vec4(vPosition.xyz, length(vPosition));\n}\n"},"skydome":{"vertex":"#ifdef GL_ES\n  precision mediump float;\n#endif\nattribute vec4 aPosition;\nattribute vec2 aTexCoord;\nuniform mat4 uMatrix;\nvarying vec2 vTexCoord;\nvarying float vFogIntensity;\nfloat gradientHeight = 10.0;\nfloat gradientStrength = 1.0;\nvoid main() {\n  gl_Position = uMatrix * aPosition;\n  vTexCoord = aTexCoord;\n  vFogIntensity = clamp((gradientHeight-aPosition.z) / (gradientHeight/gradientStrength), 0.0, gradientStrength);\n}\n","fragment":"#ifdef GL_ES\n  precision mediump float;\n#endif\nuniform sampler2D uTileImage;\nuniform vec3 uFogColor;\nvarying vec2 vTexCoord;\nvarying float vFogIntensity;\nvoid main() {\n  vec3 color = vec3(texture2D(uTileImage, vec2(vTexCoord.x, -vTexCoord.y)));\n  gl_FragColor = vec4(mix(color, uFogColor, vFogIntensity), 1.0);\n}\n"},"buildings":{"vertex":"#ifdef GL_ES\n  precision mediump float;\n#endif\nattribute vec4 aPosition;\nattribute vec3 aNormal;\nattribute vec3 aColor;\nattribute vec3 aIDColor;\nuniform mat4 uMatrix;\nuniform mat4 uMMatrix;\nuniform mat3 uNormalTransform;\nuniform vec3 uLightDirection;\nuniform vec3 uLightColor;\nuniform vec3 uFogColor;\nuniform float uFogRadius;\nuniform vec3 uHighlightColor;\nuniform vec3 uHighlightID;\nvarying vec3 vColor;\nfloat fogBlur = 200.0;\nfloat gradientHeight = 90.0;\nfloat gradientStrength = 0.4;\nvoid main() {\n  vec4 glPosition = uMatrix * aPosition;\n  gl_Position = glPosition;\n  //*** highlight object ******************************************************\n  vec3 color = aColor;\n  if (uHighlightID.r == aIDColor.r && uHighlightID.g == aIDColor.g && uHighlightID.b == aIDColor.b) {\n    color = mix(aColor, uHighlightColor, 0.5);\n  }\n  //*** light intensity, defined by light direction on surface ****************\n  vec3 transformedNormal = aNormal * uNormalTransform;\n  float lightIntensity = max( dot(transformedNormal, uLightDirection), 0.0) / 1.5;\n  color = color + uLightColor * lightIntensity;\n  //*** vertical shading ******************************************************\n  float verticalShading = clamp((gradientHeight-aPosition.z) / (gradientHeight/gradientStrength), 0.0, gradientStrength);\n  //*** fog *******************************************************************\n  vec4 mPosition = uMMatrix * aPosition;\n  float distance = length(mPosition);\n  float fogIntensity = (distance - uFogRadius) / fogBlur + 1.1; // <- shifts blur in/out\n  fogIntensity = clamp(fogIntensity, 0.0, 1.0);\n  //***************************************************************************\n  vColor = mix(vec3(color - verticalShading), uFogColor, fogIntensity);\n}\n","fragment":"#ifdef GL_ES\n  precision mediump float;\n#endif\nvarying vec3 vColor;\nvoid main() {\n  gl_FragColor = vec4(vColor, 1.0);\n}\n"},"basemap":{"vertex":"#ifdef GL_ES\n  precision mediump float;\n#endif\nattribute vec4 aPosition;\nattribute vec2 aTexCoord;\nuniform mat4 uMMatrix;\nuniform mat4 uMatrix;\nuniform float uFogRadius;\nvarying vec2 vTexCoord;\nvarying float vFogIntensity;\nfloat fogBlur = 200.0;\nvoid main() {\n  vec4 glPosition = uMatrix * aPosition;\n  gl_Position = glPosition;\n  vTexCoord = aTexCoord;\n  //*** fog *******************************************************************\n  vec4 mPosition = uMMatrix * aPosition;\n  float distance = length(mPosition);\n// (distance - (uFogRadius - fogBlur)) / (uFogRadius - (uFogRadius - fogBlur));\n  float fogIntensity = (distance - uFogRadius) / fogBlur + 1.1; // <- shifts blur in/out\n  vFogIntensity = clamp(fogIntensity, 0.0, 1.0);\n}\n","fragment":"#ifdef GL_ES\n  precision mediump float;\n#endif\nuniform sampler2D uTileImage;\nuniform vec3 uFogColor;\nvarying vec2 vTexCoord;\nvarying float vFogIntensity;\nvoid main() {\n  vec3 color = vec3(texture2D(uTileImage, vec2(vTexCoord.x, -vTexCoord.y)));\n  gl_FragColor = vec4(mix(color, uFogColor, vFogIntensity), 1.0);\n}\n"}};



var Triangulate = {};

(function() {

  var LAT_SEGMENTS = 16, LON_SEGMENTS = 24;

  function isVertical(a, b, c) {
    var d1x = a[0]-b[0];
    var d1y = a[1]-b[1];
    var d1z = a[2]-b[2];

    var d2x = b[0]-c[0];
    var d2y = b[1]-c[1];
    var d2z = b[2]-c[2];

    var nx = d1y*d2z - d1z*d2y;
    var ny = d1z*d2x - d1x*d2z;
    var nz = d1x*d2y - d1y*d2x;

    var n = unit(nx, ny, nz);
    return Math.round(n[2]*5000) === 0;
  }

  Triangulate.quad = function(tris, a, b, c, d) {
    this.addTriangle(tris, a, b, c);
    this.addTriangle(tris, b, d, c);
    return 6;
  };

  Triangulate.circle = function(tris, center, radius, z) {
    var u, v;
    for (var i = 0; i < LON_SEGMENTS; i++) {
      u = i/LON_SEGMENTS;
      v = (i+1)/LON_SEGMENTS;
      this.addTriangle(
        tris,
        [ center[0] + radius * Math.sin(u*Math.PI*2), center[1] + radius * Math.cos(u*Math.PI*2), z ],
        [ center[0],                                  center[1],                                  z ],
        [ center[0] + radius * Math.sin(v*Math.PI*2), center[1] + radius * Math.cos(v*Math.PI*2), z ]
      );
    }
    return LON_SEGMENTS*3;
  };

  Triangulate.polygon = function(tris, polygon, z) {
    var vertices = earcut(polygon);
    for (var i = 0, il = vertices.length-2; i < il; i+=3) {
      this.addTriangle(
        tris,
        [ vertices[i  ][0], vertices[i  ][1], z ],
        [ vertices[i+1][0], vertices[i+1][1], z ],
        [ vertices[i+2][0], vertices[i+2][1], z ]
      );
    }
    return vertices.length;
  };

  Triangulate.polygon3d = function(tris, polygon) {
    var ring = polygon[0];
    var ringLength = ring.length;
    var vertices, t, tl;

//  { r:255, g:0, b:0 }

    if (ringLength <= 4) { // 3: a triangle
      var vertexCount = 0;
      vertexCount += this.addTriangle(
        tris,
        ring[0],
        ring[2],
        ring[1]
      );

      if (ringLength === 4) { // 4: a quad (2 triangles)
        vertexCount += this.addTriangle(
          tris,
          ring[0],
          ring[3],
          ring[2]
        );
      }
      return vertexCount;
    }

    if (isVertical(ring[0], ring[1], ring[2])) {
      for (var i = 0, il = polygon[0].length; i < il; i++) {
        polygon[0][i] = [
          polygon[0][i][2],
          polygon[0][i][1],
          polygon[0][i][0]
        ];
      }

      vertices = earcut(polygon);
      for (t = 0, tl = vertices.length-2; t < tl; t+=3) {
        this.addTriangle(
          tris,
          [ vertices[t  ][2], vertices[t  ][1], vertices[t  ][0] ],
          [ vertices[t+1][2], vertices[t+1][1], vertices[t+1][0] ],
          [ vertices[t+2][2], vertices[t+2][1], vertices[t+2][0] ]
        );
      }

      return vertices.length;
    }

    vertices = earcut(polygon);
    for (t = 0, tl = vertices.length-2; t < tl; t+=3) {
      this.addTriangle(
        tris,
        [ vertices[t  ][0], vertices[t  ][1], vertices[t  ][2] ],
        [ vertices[t+1][0], vertices[t+1][1], vertices[t+1][2] ],
        [ vertices[t+2][0], vertices[t+2][1], vertices[t+2][2] ]
      );
    }

    return vertices.length;
  };

  Triangulate.cylinder = function(tris, center, radiusBottom, radiusTop, minHeight, height) {
    var
      vertexCount = 0,
      currAngle, nextAngle,
      currSin, currCos,
      nextSin, nextCos,
      num = LON_SEGMENTS,
      doublePI = Math.PI*2;

    for (var i = 0; i < num; i++) {
      currAngle = ( i   /num) * doublePI;
      nextAngle = ((i+1)/num) * doublePI;

      currSin = Math.sin(currAngle);
      currCos = Math.cos(currAngle);

      nextSin = Math.sin(nextAngle);
      nextCos = Math.cos(nextAngle);

      vertexCount += this.addTriangle(
        tris,
        [ center[0] + radiusBottom*currSin, center[1] + radiusBottom*currCos, minHeight ],
        [ center[0] + radiusTop   *nextSin, center[1] + radiusTop   *nextCos, height    ],
        [ center[0] + radiusBottom*nextSin, center[1] + radiusBottom*nextCos, minHeight ]
      );

      if (radiusTop !== 0) {
        vertexCount += this.addTriangle(
          tris,
          [ center[0] + radiusTop   *currSin, center[1] + radiusTop   *currCos, height    ],
          [ center[0] + radiusTop   *nextSin, center[1] + radiusTop   *nextCos, height    ],
          [ center[0] + radiusBottom*currSin, center[1] + radiusBottom*currCos, minHeight ]
        );
      }
    }

    return vertexCount;
  };

  Triangulate.dome = function(tris, center, radius, minHeight, height) {
    var
      vertexCount = 0,
      currAngle, nextAngle,
      currSin, currCos,
      nextSin, nextCos,
      currRadius, nextRadius,
      currY, nextY,
      h = (height-minHeight),
      num = LAT_SEGMENTS/2,
      halfPI = Math.PI/2;

    for (var i = 0; i < num; i++) {
      currAngle = ( i   /num) * halfPI - halfPI;
      nextAngle = ((i+1)/num) * halfPI - halfPI;

      currSin = Math.sin(currAngle);
      currCos = Math.cos(currAngle);

      nextSin = Math.sin(nextAngle);
      nextCos = Math.cos(nextAngle);

      currRadius = currCos*radius;
      nextRadius = nextCos*radius;

      currY = minHeight - currSin*h;
      nextY = minHeight - nextSin*h;

      vertexCount += this.cylinder(tris, center, nextRadius, currRadius, nextY, currY);
    }

    return vertexCount;
  };

  Triangulate.pyramid = function(tris, polygon, center, minHeight, height) {
    polygon = polygon[0];
    var vertexCount = 0;
    for (var i = 0, il = polygon.length-1; i < il; i++) {
      vertexCount += this.addTriangle(
        tris,
        [ polygon[i  ][0], polygon[i  ][1], minHeight ],
        [ polygon[i+1][0], polygon[i+1][1], minHeight ],
        [ center[0], center[1], height ]
      );
    }
    return vertexCount;
  };

  Triangulate.extrusion = function(tris, polygon, minHeight, height) {
    var
      vertexCount = 0,
      ring, last,
      a, b, z0, z1;

    for (var c = 0, pl = polygon.length; c < pl; c++) {
      ring = polygon[c];
      last = ring.length-1;

      if (ring[0][0] !== ring[last][0] || ring[0][1] !== ring[last][1]) {
        ring.push(ring[0]);
        last++;
      }

      for (var r = 0; r < last; r++) {
        a = ring[r];
        b = ring[r+1];
        z0 = minHeight;
        z1 = height;
        vertexCount += this.quad(
          tris,
          [ a[0], a[1], z0 ],
          [ b[0], b[1], z0 ],
          [ a[0], a[1], z1 ],
          [ b[0], b[1], z1 ]
        );
      }
    }
    return vertexCount;
  };

  Triangulate.addTriangle = function(tris, a, b, c) {
    tris.vertices.push(
      a[0], a[1], a[2],
      c[0], c[1], c[2],
      b[0], b[1], b[2]
    );

    var n = normal(
      a[0], a[1], a[2],
      b[0], b[1], b[2],
      c[0], c[1], c[2]
    );

    tris.normals.push(
      n[0], n[1], n[2],
      n[0], n[1], n[2],
      n[0], n[1], n[2]
    );

    return 3;
  };

}());


var data = {
  Index: {
    items: [],

    add: function(item) {
      this.items.push(item);
    },

    remove: function(item) {
      var items = this.items;
      for (var i = 0, il = items.length; i < il; i++) {
        if (items[i] === item) {
          items.splice(i, 1);
          return;
        }
      }
    },

    destroy: function() {
      this.items = null;
    }
  }
};


var DataGrid = {};

(function() {

  var
    source,
    isDelayed,

    zoom,
    minX,
    minY,
    maxX,
    maxY,

    tiles = {},
    fixedZoom = 16;

  function update(delay) {
    updateTileBounds();

    if (!delay) {
      loadTiles();
      return;
    }

    // strategy: start loading in {delay} after movement ends, skip any attempts until then

    if (isDelayed) {
      clearTimeout(isDelayed);
    }

    isDelayed = setTimeout(function() {
      isDelayed = null;
      loadTiles();
    }, delay);
  }

  function updateTileBounds() {
    zoom = Math.round(fixedZoom || Map.zoom);

    var
      scale = Math.pow(2, zoom-Map.zoom)/TILE_SIZE,
      mapBounds = Map.bounds,
      perspectiveBuffer = 1;

    minX = (mapBounds.minX*scale <<0) - perspectiveBuffer;
    minY = (mapBounds.minY*scale <<0) + 1 - perspectiveBuffer;
    maxX = Math.ceil(mapBounds.maxX*scale) + perspectiveBuffer;
    maxY = Math.ceil(mapBounds.maxY*scale) + 1 + perspectiveBuffer;

//console.log('rect', minX, maxX, minY, maxY);
//
//
//var scale = Math.pow(2, Map.zoom) / (Math.cos(Map.position.latitude*Math.PI/180) * EARTH_CIRCUMFERENCE);
//var scale2 = Math.pow(2, zoom-Map.zoom);
//
//    var
//      mapCenter = Map.center,
//      fogRadius = Renderer.fogRadius*scale;
//
//    var minX2 = ((mapCenter.x/TILE_SIZE-fogRadius)*scale2 <<0) - 0 - perspectiveBuffer;
//    var minY2 = ((mapCenter.y/TILE_SIZE+fogRadius)*scale2 <<0) - 1 - perspectiveBuffer;
//    var maxX2 = Math.ceil(mapCenter.x/TILE_SIZE-fogRadius)*scale2 + 2 +perspectiveBuffer;
//    var maxY2 = Math.ceil(mapCenter.y/TILE_SIZE+fogRadius)*scale2 + perspectiveBuffer;
//
//    console.log('circle', minX2, maxX2, minY2, maxY2, fogRadius);
  }

  function loadTiles() {
    if (Map.zoom < MIN_ZOOM) {
      return;
    }

    var
      tileX, tileY,
      key,
      queue = [], queueLength,
      tileAnchor = [
        minX + (maxX-minX-1)/2,
        maxY
      ];

    for (tileY = minY; tileY < maxY; tileY++) {
      for (tileX = minX; tileX < maxX; tileX++) {
        key = [tileX, tileY, zoom].join(',');
        if (tiles[key]) {
          continue;
        }
        tiles[key] = new DataTile(tileX, tileY, zoom);
        queue.push({ tile:tiles[key], dist:distance2([tileX, tileY], tileAnchor) });
      }
    }

    if (!(queueLength = queue.length)) {
      return;
    }

    queue.sort(function(a, b) {
      return a.dist-b.dist;
    });

    var tile;
    for (var i = 0; i < queueLength; i++) {
      tile = queue[i].tile;
      tile.load(getURL(tile.tileX, tile.tileY, tile.zoom));
    }

    purge();
  }

  function purge() {
    for (var key in tiles) {
      if (!isVisible(tiles[key], 1)) { // testing with buffer of n tiles around viewport TODO: this is bad with fixedTileSIze
        tiles[key].destroy();
        delete tiles[key];
      }
    }
  }

  function isVisible(tile, buffer) {
    buffer = buffer || 0;

    var
      tileX = tile.tileX,
      tileY = tile.tileY;

    return (tile.zoom === zoom &&
      // TODO: factor in tile origin
    (tileX >= minX-buffer && tileX <= maxX+buffer && tileY >= minY-buffer && tileY <= maxY+buffer));
  }

  function getURL(x, y, z) {
    var s = 'abcd'[(x+y) % 4];
    return pattern(source, { s:s, x:x, y:y, z:z });
  }

  //***************************************************************************

  DataGrid.setSource = function(src, dataKey) {
    if (src === undefined || src === false || src === '') {
      src = DATA_SRC.replace('{k}', dataKey);
    }

    if (!src) {
      return;
    }

    source = src;

    Events.on('change', function() {
      update(500);
    });

    Events.on('resize', update);

    update();
  };

  DataGrid.destroy = function() {
    clearTimeout(isDelayed);
    for (var key in tiles) {
      tiles[key].destroy();
    }
    tiles = null;
  };

}());


var DataTile = function(tileX, tileY, zoom) {
  this.tileX = tileX;
  this.tileY = tileY;
  this.zoom = zoom;
};

DataTile.prototype = {

  load: function(url) {
    this.mesh = new mesh.GeoJSON(url);
  },

  destroy: function() {
    if (this.mesh) {
      this.mesh.destroy();
      this.mesh = null;
    }
  }
};


var TileGrid = {};

(function() {

  var
    source,
    isDelayed,
    zoom,
    minX,
    minY,
    maxX,
    maxY,
    tiles = {};

  function update(delay) {
    updateTileBounds();

    if (!delay) {
      loadTiles();
      return;
    }

    // strategy: start loading after {delay}, skip any attempts until then
    // effectively loads in intervals during movement

    if (isDelayed) {
      return;
    }

    isDelayed = setTimeout(function() {
      isDelayed = null;
      loadTiles();
    }, delay);
  }

  // TODO: signal, if bbox changed => for loadTiles() + Tile.isVisible()
  function updateTileBounds() {
    zoom = Math.round(Map.zoom);

    var
      ratio = Math.pow(2, zoom-Map.zoom)/TILE_SIZE,
      mapBounds = Map.bounds,
      perspectiveBuffer = 1;

    minX = (mapBounds.minX*ratio <<0) - perspectiveBuffer;
    minY = (mapBounds.minY*ratio <<0) - perspectiveBuffer;
    maxX = Math.ceil(mapBounds.maxX*ratio) + perspectiveBuffer;
    maxY = Math.ceil(mapBounds.maxY*ratio) + perspectiveBuffer;
  }

  function loadTiles() {
    var
      tileX, tileY,
      key,
      queue = [], queueLength,
      tileAnchor = [
        minX + (maxX-minX-1)/2,
        maxY
      ];

    for (tileY = minY; tileY < maxY; tileY++) {
      for (tileX = minX; tileX < maxX; tileX++) {
        key = [tileX, tileY, zoom].join(',');
        if (tiles[key]) {
          continue;
        }
        tiles[key] = new MapTile(tileX, tileY, zoom);
        // TODO: rotate anchor point
        queue.push({ tile:tiles[key], dist:distance2([tileX, tileY], tileAnchor) });
      }
    }

    if (!(queueLength = queue.length)) {
      return;
    }

    queue.sort(function(a, b) {
      return a.dist-b.dist;
    });

    var tile;
    for (var i = 0; i < queueLength; i++) {
      tile = queue[i].tile;
      tile.load(getURL(tile.tileX, tile.tileY, tile.zoom));
    }

    purge();
  }

  function purge() {
    for (var key in tiles) {
      if (!isVisible(tiles[key], 1)) {
        tiles[key].destroy();
        delete tiles[key];
      }
    }
  }

  function isVisible(tile, buffer) {
    buffer = buffer || 0;

    var
      tileX = tile.tileX,
      tileY = tile.tileY;

    return (tile.zoom === zoom &&
      // TODO: factor in tile origin
    (tileX >= minX-buffer && tileX <= maxX+buffer && tileY >= minY-buffer && tileY <= maxY+buffer));
  }

  function getURL(x, y, z) {
    var s = 'abcd'[(x+y) % 4];
    return pattern(source, { s:s, x:x, y:y, z:z });
  }

  //***************************************************************************

  TileGrid.setSource = function(src) {
    if (!src) {
      return;
    }

    source = src;

    Events.on('change', function() {
      update(500);
    });

    Events.on('resize', update);

    update();
  };

  TileGrid.getTiles = function() {
    return tiles;
  };

  TileGrid.destroy = function() {
    clearTimeout(isDelayed);
    for (var key in tiles) {
      tiles[key].destroy();
    }
    tiles = null;
  };

}());


var MapTile = function(tileX, tileY, zoom) {
  this.tileX = tileX;
  this.tileY = tileY;
  this.zoom = zoom;

  var numSegments = 4;

  var meshStep = 255/numSegments;
  var textureStep = 1/numSegments;

  var vertices = [];
  var texCoords = [];

  for (var cols = 0; cols < numSegments; cols++) {
    for (var rows = 0; rows < numSegments; rows++) {
      vertices.push(
        (cols+1)*meshStep, (rows+1)*meshStep, 0,
        (cols+1)*meshStep, (rows+0)*meshStep, 0,
        (cols+0)*meshStep, (rows+1)*meshStep, 0,
        (cols+0)*meshStep, (rows+0)*meshStep, 0
      );

      texCoords.push(
        (cols+1)*textureStep, (rows+1)*textureStep,
        (cols+1)*textureStep, (rows+0)*textureStep,
        (cols+0)*textureStep, (rows+1)*textureStep,
        (cols+0)*textureStep, (rows+0)*textureStep
      );
    }
  }

  this.vertexBuffer = new glx.Buffer(3, new Float32Array(vertices));
  this.texCoordBuffer = new glx.Buffer(2, new Float32Array(texCoords));
};

MapTile.prototype = {

  load: function(url) {
    Activity.setBusy();
    this.texture = new glx.texture.Image(url, function(image) {
      Activity.setIdle();
      if (image) {
        this.isReady = true;
      }
    }.bind(this));
  },

  getMatrix: function() {
    if (!this.isReady) {
      return;
    }

    var mMatrix = new glx.Matrix();

    var
      ratio = 1 / Math.pow(2, this.zoom - Map.zoom),
      mapCenter = Map.center;

    mMatrix.scale(ratio * 1.005, ratio * 1.005, 1);
    mMatrix.translate(this.tileX * TILE_SIZE * ratio - mapCenter.x, this.tileY * TILE_SIZE * ratio - mapCenter.y, 0);

    return mMatrix;
  },

  destroy: function() {
    this.vertexBuffer.destroy();
    this.texCoordBuffer.destroy();
    if (this.texture) {
      this.texture.destroy();
    }
    Activity.setIdle();
  }
};


var mesh = {};

//mesh._replaceItems: function() {
//  if (this.replaces.length) {
//    var replaces = this.replaces;
//      if (replaces.indexOf(item.id)>=0) {
//        item.hidden = true;
//      }
//    });
//  }
//};


mesh.GeoJSON = (function() {

  var
    zoom = 16,
    worldSize = TILE_SIZE <<zoom,
    featuresPerChunk = 150,
    delayPerChunk = 66;

  //***************************************************************************

  function constructor(url, options) {
    options = options || {};

    this._id = options.id;
    if (options.color) {
      this._color = Color.parse(options.color).toRGBA(true);
    }
    //this._replaces = options.replaces || [];

    this.scale     = options.scale     || 1;
    this.rotation  = options.rotation  || 0;
    this.elevation = options.elevation || 0;
    this.position  = {};

    this._data = {
      vertices: [],
      normals: [],
      colors: [],
      idColors: []
    };

    Activity.setBusy();
    if (typeof url === 'object') {
      var json = url;
      this._onLoad(json);
    } else {
      this._request = Request.getJSON(url, function(json) {
        this._request = null;
        this._onLoad(json);
      }.bind(this));
    }
  }

  constructor.prototype = {

    _onLoad: function(json) {
      if (!json || !json.features.length) {
        return;
      }

      var coordinates0 = json.features[0].geometry.coordinates[0][0];
      this.position = { latitude: coordinates0[1], longitude: coordinates0[0] };

      relax(function(startIndex, endIndex) {
        var features = json.features.slice(startIndex, endIndex);
        var geojson = { type: 'FeatureCollection', features: features };
        var data = GeoJSON.parse(this.position, worldSize, geojson);

        this._addItems(data);

        if (endIndex === json.features.length) {
          this._onReady();
        }
      }.bind(this), 0, json.features.length, featuresPerChunk, delayPerChunk);
    },

    _addItems: function(items) {
      var
        item, color, idColor, bbox, center, radius,
        vertexCount,
        j;
      for (var i = 0, il = items.length; i < il; i++) {
        item = items[i];

        idColor = Interaction.idToColor(this._id || item.id);

        if ((item.roofShape === 'cone' || item.roofShape === 'dome') && !item.shape && isRotational(item.geometry)) {
          item.shape = 'cylinder';
          item.isRotational = true;
        }

        bbox = getBBox(item.geometry);
        center = [bbox.minX + (bbox.maxX - bbox.minX)/2, bbox.minY + (bbox.maxY - bbox.minY)/2];

        if (item.isRotational) {
          radius = (bbox.maxX - bbox.minX)/2;
        }

        switch (item.shape) {
          case 'cylinder': vertexCount = Triangulate.cylinder(this._data, center, radius, radius, item.minHeight, item.height); break;
          case 'cone':     vertexCount = Triangulate.cylinder(this._data, center, radius, 0, item.minHeight, item.height); break;
          case 'dome':     vertexCount = Triangulate.dome(this._data, center, radius, item.minHeight, item.height); break;
          case 'sphere':   vertexCount = Triangulate.cylinder(this._data, center, radius, radius/2, item.minHeight, item.height); break;
          case 'pyramid':  vertexCount = Triangulate.pyramid(this._data, item.geometry, center, item.minHeight, item.height); break;
          default:         vertexCount = Triangulate.extrusion(this._data, item.geometry, item.minHeight, item.height);
        }

        color = this._color || item.wallColor || DEFAULT_COLOR;
        for (j = 0; j < vertexCount; j++) {
          this._data.colors.push(color.r, color.g, color.b);
          this._data.idColors.push(idColor.r/255, idColor.g/255, idColor.b/255);
        }

        switch (item.roofShape) {
          case 'cone':     vertexCount = Triangulate.cylinder(this._data, center, radius, 0, item.height, item.height+item.roofHeight); break;
          case 'dome':     vertexCount = Triangulate.dome(this._data, center, radius, item.height, item.height+item.roofHeight); break;
          case 'pyramid':  vertexCount = Triangulate.pyramid(this._data, item.geometry, center, item.height, item.height+item.roofHeight); break;
          default:
            if (item.shape === 'cylinder') {
              vertexCount = Triangulate.circle(this._data, center, radius, item.height);
            } else if (item.shape === undefined) {
              vertexCount = Triangulate.polygon(this._data, item.geometry, item.height);
            }
        }

        color = this._color || item.roofColor || DEFAULT_COLOR;
        for (j = 0; j < vertexCount; j++) {
          this._data.colors.push(color.r, color.g, color.b);
          this._data.idColors.push(idColor.r/255, idColor.g/255, idColor.b/255);
        }
      }
    },

    _onReady: function() {
      this.vertexBuffer  = new glx.Buffer(3, new Float32Array(this._data.vertices));
      this.normalBuffer  = new glx.Buffer(3, new Float32Array(this._data.normals));
      this.colorBuffer   = new glx.Buffer(3, new Float32Array(this._data.colors));
      this.idColorBuffer = new glx.Buffer(3, new Float32Array(this._data.idColors));

      this._data = null;

      data.Index.add(this);
      this._isReady = true;

      Activity.setIdle();
    },

    // TODO: switch to mesh.transform
    getMatrix: function() {
      var matrix = new glx.Matrix();

      if (this.elevation) {
        matrix.translate(0, 0, this.elevation);
      }

      var scale = 1 / Math.pow(2, zoom - Map.zoom) * this.scale;
      matrix.scale(scale, scale, scale*0.7);

      if (this.rotation) {
        matrix.rotateZ(-this.rotation);
      }

      var
        position = project(this.position.latitude, this.position.longitude, TILE_SIZE*Math.pow(2, Map.zoom)),
        mapCenter = Map.center;

      matrix.translate(position.x-mapCenter.x, position.y-mapCenter.y, 0);

      return matrix;
    },

    destroy: function() {
      if (this._request) {
        this._request.abort();
      }

      if (this._isReady) {
        data.Index.remove(this);
        this.vertexBuffer.destroy();
        this.normalBuffer.destroy();
        this.colorBuffer.destroy();
        this.idColorBuffer.destroy();
      }
    }
  };

  return constructor;

}());


mesh.OBJ = (function() {

  function constructor(url, position, options) {
    options = options || {};

    this._id = options.id;
    if (options.color) {
      this._color = Color.parse(options.color).toRGBA(true);
    }
    this.replaces  = options.replaces || [];

    this.scale     = options.scale     || 1;
    this.rotation  = options.rotation  || 0;
    this.elevation = options.elevation || 0;
    this.position  = position;

    this._inMeters = TILE_SIZE / (Math.cos(this.position.latitude*Math.PI/180) * EARTH_CIRCUMFERENCE);

    this._vertices = [];
    this._normals = [];
    this._colors = [];
    this._idColors = [];

    Activity.setBusy();
    this._request = Request.getText(url, function(obj) {
      this._request = null;
      var match;
      if ((match = obj.match(/^mtllib\s+(.*)$/m))) {
        this._request = Request.getText(url.replace(/[^\/]+$/, '') + match[1], function(mtl) {
          this._request = null;
          this._onLoad(obj, mtl);
        }.bind(this));
      } else {
        this._onLoad(obj, null);
      }
    }.bind(this));
  }

  constructor.prototype = {
    _onLoad: function(obj, mtl) {
      var data = new OBJ.parse(obj, mtl);
      this._addItems(data);
      this._onReady();
    },

    _addItems: function(items) {
      var item, color, idColor, j, jl;

      for (var i = 0, il = items.length; i<il; i++) {
        item = items[i];

        this._vertices.push.apply(this._vertices, item.vertices);
        this._normals.push.apply(this._normals, item.normals);

        color = this._color || item.color || DEFAULT_COLOR;
        idColor = Interaction.idToColor(this._id || item.id);

        for (j = 0, jl = item.vertices.length - 2; j<jl; j += 3) {
          this._colors.push(color.r, color.g, color.b);
          this._idColors.push(idColor.r/255, idColor.g/255, idColor.b/255);
        }
      }
    },

    _onReady: function() {
      this.vertexBuffer  = new glx.Buffer(3, new Float32Array(this._vertices));
      this.normalBuffer  = new glx.Buffer(3, new Float32Array(this._normals));
      this.colorBuffer   = new glx.Buffer(3, new Float32Array(this._colors));
      this.idColorBuffer = new glx.Buffer(3, new Float32Array(this._idColors));

      this._vertices = null;
      this._normals = null;
      this._colors = null;
      this._idColors = null;

      data.Index.add(this);
      this._isReady = true;

      Activity.setIdle();
    },

    // TODO: switch to mesh.transform
    getMatrix: function() {
      var matrix = new glx.Matrix();

      if (this.elevation) {
        matrix.translate(0, 0, this.elevation);
      }

      var scale = Math.pow(2, Map.zoom) * this._inMeters * this.scale;
      matrix.scale(scale, scale, scale);

      if (this.rotation) {
        matrix.rotateZ(-this.rotation);
      }

      var
        position = project(this.position.latitude, this.position.longitude, TILE_SIZE*Math.pow(2, Map.zoom)),
        mapCenter = Map.center;

      matrix.translate(position.x-mapCenter.x, position.y-mapCenter.y, 0);

      return matrix;
    },

    destroy: function() {
      if (this._request) {
        this._request.abort();
      }

      if (this._isReady) {
        data.Index.remove(this);
        this.vertexBuffer.destroy();
        this.normalBuffer.destroy();
        this.colorBuffer.destroy();
        this.idColorBuffer.destroy();
      }
    }
  };

  return constructor;

}());


var GeoJSON = {};

(function() {

  var METERS_PER_LEVEL = 3;

  var materialColors = {
    brick:'#cc7755',
    bronze:'#ffeecc',
    canvas:'#fff8f0',
    concrete:'#999999',
    copper:'#a0e0d0',
    glass:'#e8f8f8',
    gold:'#ffcc00',
    plants:'#009933',
    metal:'#aaaaaa',
    panel:'#fff8f0',
    plaster:'#999999',
    roof_tiles:'#f08060',
    silver:'#cccccc',
    slate:'#666666',
    stone:'#996666',
    tar_paper:'#333333',
    wood:'#deb887'
  };

  var baseMaterials = {
    asphalt:'tar_paper',
    bitumen:'tar_paper',
    block:'stone',
    bricks:'brick',
    glas:'glass',
    glassfront:'glass',
    grass:'plants',
    masonry:'stone',
    granite:'stone',
    panels:'panel',
    paving_stones:'stone',
    plastered:'plaster',
    rooftiles:'roof_tiles',
    roofingfelt:'tar_paper',
    sandstone:'stone',
    sheet:'canvas',
    sheets:'canvas',
    shingle:'tar_paper',
    shingles:'tar_paper',
    slates:'slate',
    steel:'metal',
    tar:'tar_paper',
    tent:'canvas',
    thatch:'plants',
    tile:'roof_tiles',
    tiles:'roof_tiles'
    // cardboard
    // eternit
    // limestone
    // straw
  };

  function getMaterialColor(str) {
    str = str.toLowerCase();
    if (str[0] === '#') {
      return str;
    }
    return materialColors[baseMaterials[str] || str] || null;
  }

  /**
   * from turf.rewind
   * Uses [Shoelace Formula]{@link http://en.wikipedia.org/wiki/Shoelace_formula}
   * @author Abel Vázquez
   * @version 1.0.0
   */

  function isClockWise(latlngs) {
    return 0 < latlngs.reduce(function(a, b, c, d) {
        return a + ((c < d.length - 1) ? (d[c+1][0] - b[0]) * (d[c+1][1] + b[1]) : 0);
      }, 0);
  }

  function parseFeature(res, origin, worldSize, feature) {
    var
      prop = feature.properties,
      item = {},
      color,
      wallColor, roofColor;

    if (!prop) {
      return;
    }

    item.height    = prop.height    || (prop.levels   ? prop.levels  *METERS_PER_LEVEL : DEFAULT_HEIGHT);
    item.minHeight = prop.minHeight || (prop.minLevel ? prop.minLevel*METERS_PER_LEVEL : 0);

    wallColor = prop.material ? getMaterialColor(prop.material) : (prop.wallColor || prop.color);
    item.wallColor = (color = Color.parse(wallColor)) ? color.toRGBA(true) : DEFAULT_COLOR;

    roofColor = prop.roofMaterial ? getMaterialColor(prop.roofMaterial) : prop.roofColor;
    item.roofColor = (color = Color.parse(roofColor)) ? color.toRGBA(true) : DEFAULT_COLOR;

    switch (prop.shape) {
      case 'cylinder':
      case 'cone':
      case 'dome':
      case 'sphere':
        item.shape = prop.shape;
        item.isRotational = true;
        break;

      case 'pyramid':
        item.shape = prop.shape;
        break;
    }

    switch (prop.roofShape) {
      case 'cone':
      case 'dome':
        item.roofShape = prop.roofShape;
        item.isRotational = true;
        break;

      case 'pyramid':
        item.roofShape = prop.roofShape;
        break;
    }

    if (item.roofShape && prop.roofHeight) {
      item.roofHeight = prop.roofHeight;
      item.height = Math.max(0, item.height-item.roofHeight);
    } else {
      item.roofHeight = 0;
    }

    //if (item.height+item.roofHeight <= item.minHeight) {
    //  return;
    //}

    item.id = prop.relationId || feature.id || prop.id;

    var geometries = getGeometries(feature.geometry);
    var clonedItem = Object.create(item);

    for (var i = 0, il = geometries.length; i < il; i++) {
      clonedItem.geometry = transform(origin, worldSize, geometries[i]);

      if ((clonedItem.roofShape === 'cone' || clonedItem.roofShape === 'dome') && !clonedItem.shape && isRotational(clonedItem.geometry)) {
        clonedItem.shape = 'cylinder';
        clonedItem.isRotational = true;
      }

      res.push(clonedItem);
    }
  }

  function getGeometries(geometry) {
    var i, il, polygonRings, sub;
    switch (geometry.type) {
      case 'GeometryCollection':
        var geometries = [];
        for (i = 0, il = geometry.geometries.length; i < il; i++) {
          if ((sub = getGeometries(geometry.geometries[i]))) {
            geometries.push.apply(geometries, sub);
          }
        }
        return geometries;

      case 'MultiPolygon':
        var polygons = [];
        for (i = 0, il = geometry.coordinates.length; i < il; i++) {
          if ((sub = getGeometries({ type: 'Polygon', coordinates: geometry.coordinates[i] }))) {
            polygons.push.apply(geometries, sub);
          }
        }
        return polygons;

      case 'Polygon':
        polygonRings = geometry.coordinates;
        break;

      default: return [];
    }

    var res = [];
    for (i = 0, il = polygonRings.length; i < il; i++) {
      res[i] = isClockWise(polygonRings[i]) && !i ? polygonRings[i] : polygonRings[i].reverse();
    }
    return [res];
  }

  function transform(origin, worldSize, polygon) {
    var
      res = [],
      r, rl, p,
      ring;

    for (var i = 0, il = polygon.length; i < il; i++) {
      ring = polygon[i];
      res[i] = [];
      for (r = 0, rl = ring.length-1; r < rl; r++) {
        p = project(ring[r][1], ring[r][0], worldSize);
        res[i][r] = [p.x-origin.x, p.y-origin.y];
      }
    }

    return res;
  }

  //***************************************************************************

  GeoJSON.parse = function(position, worldSize, geojson) {
    var res = [];

    if (geojson && geojson.type === 'FeatureCollection' && geojson.features.length) {

      var
        collection = geojson.features,
        origin = project(position.latitude, position.longitude, worldSize);

      for (var i = 0, il = collection.length; i<il; i++) {
        parseFeature(res, origin, worldSize, collection[i]);
      }
    }

    return res;
  };

}());


var OBJ = function() {
  this.vertices = [];
};

if (typeof module !== 'undefined') {
  module.exports = OBJ;
}

OBJ.prototype = {

  parseMaterials: function(str) {
    var lines = str.split(/[\r\n]/g), cols;
    var i, il;

    var materials = {};
    var data = null;

    for (i = 0, il = lines.length; i < il; i++) {
  	  cols = lines[i].trim().split(/\s+/);

      switch (cols[0]) {
  	    case 'newmtl':
          this.storeMaterial(materials, data);
          data = { id:cols[1], color:{} };
        break;

  	    case 'Kd':
  	      data.color.r = parseFloat(cols[1]);
  	      data.color.g = parseFloat(cols[2]);
  	      data.color.b = parseFloat(cols[3]);
  	    break;

  	    case 'd':
          data.color.a = parseFloat(cols[1]);
        break;
  	  }
    }

    this.storeMaterial(materials, data);

    str = null;

    return materials;
  },

  storeMaterial: function(materials, data) {
    if (data !== null) {
      materials[ data.id ] = data.color;
    }
  },

  parseModel: function(str, materials) {
    var lines = str.split(/[\r\n]/g), cols;
    var i, il;

    var meshes = [];
    var id;
    var color;
    var faces = [];

    for (i = 0, il = lines.length; i < il; i++) {
  	  cols = lines[i].trim().split(/\s+/);

      switch (cols[0]) {
        case 'g':
        case 'o':
          this.storeMesh(meshes, id, color, faces);
          id = cols[1];
          faces = [];
        break;

        case 'usemtl':
          this.storeMesh(meshes, id, color, faces);
          if (materials[ cols[1] ]) {
            color = materials[ cols[1] ];
          }
          faces = [];
        break;

        case 'v':
          this.vertices.push([parseFloat(cols[1]), parseFloat(cols[2]), parseFloat(cols[3])]);
        break;

  	    case 'f':
  	      faces.push([ parseFloat(cols[1])-1, parseFloat(cols[2])-1, parseFloat(cols[3])-1 ]);
  	    break;
	    }
    }

    this.storeMesh(meshes, id, color, faces);

    str = null;

    return meshes;
  },

  storeMesh: function(meshes, id, color, faces) {
    if (faces.length) {
      var geometry = this.createGeometry(faces);
      meshes.push({
        id: id,
        color: color,
        vertices: geometry.vertices,
        normals: geometry.normals
      });
    }
  },

  createGeometry: function(faces) {
  	var v0, v1, v2;
  	var e1, e2;
  	var nor, len;

    var geometry = { vertices:[], normals:[] };

    for (var i = 0, il = faces.length; i < il; i++) {
  		v0 = this.vertices[ faces[i][0] ];
  		v1 = this.vertices[ faces[i][1] ];
  		v2 = this.vertices[ faces[i][2] ];

      e1 = [ v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2] ];
  		e2 = [ v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2] ];

  		nor = [ e1[1]*e2[2] - e1[2]*e2[1], e1[2]*e2[0] - e1[0]*e2[2], e1[0]*e2[1] - e1[1]*e2[0] ];
  		len = Math.sqrt(nor[0]*nor[0] + nor[1]*nor[1] + nor[2]*nor[2]);

  		nor[0] /= len;
      nor[1] /= len;
      nor[2] /= len;

  		geometry.vertices.push(
        v0[0], v0[2], v0[1],
        v1[0], v1[2], v1[1],
        v2[0], v2[2], v2[1]
      );

  		geometry.normals.push(
        nor[0], nor[1], nor[2],
        nor[0], nor[1], nor[2],
        nor[0], nor[1], nor[2]
      );
    }

    return geometry;
  }
};

OBJ.parse = function(obj, mtl) {
  var
    parser = new OBJ(),
    materials = mtl ? parser.parseMaterials(mtl) : {};
  return parser.parseModel(obj, materials);
};


function distance2(a, b) {
  var
    dx = a[0]-b[0],
    dy = a[1]-b[1];
  return dx*dx + dy*dy;
}

function isRotational(coordinates) {
  var
    ring = coordinates[0],
    length = ring.length;

  if (length < 16) {
    return false;
  }

  var i;

  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (i = 0; i < length; i++) {
    minX = Math.min(minX, ring[i][0]);
    maxX = Math.max(maxX, ring[i][0]);
    minY = Math.min(minY, ring[i][1]);
    maxY = Math.max(maxY, ring[i][1]);
  }

  var
    width = maxX-minX,
    height = (maxY-minY),
    ratio = width/height;

  if (ratio < 0.85 || ratio > 1.15) {
    return false;
  }

  var
    center = [ minX+width/2, minY+height/2 ],
    radius = (width+height)/4,
    sqRadius = radius*radius;

  for (i = 0; i < length; i++) {
    var dist = distance2(ring[i], center);
    if (dist/sqRadius < 0.8 || dist/sqRadius > 1.2) {
      return false;
    }
  }

  return true;
}

function getBBox(coordinates) {
  var ring = coordinates[0];
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (var i = 0; i < ring.length; i++) {
    minX = Math.min(minX, ring[i][0]);
    maxX = Math.max(maxX, ring[i][0]);
    minY = Math.min(minY, ring[i][1]);
    maxY = Math.max(maxY, ring[i][1]);
  }
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}

function normal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  var d1x = ax-bx;
  var d1y = ay-by;
  var d1z = az-bz;

  var d2x = bx-cx;
  var d2y = by-cy;
  var d2z = bz-cz;

  var nx = d1y*d2z - d1z*d2y;
  var ny = d1z*d2x - d1x*d2z;
  var nz = d1x*d2y - d1y*d2x;

  return unit(nx, ny, nz);
}

function unit(x, y, z) {
  var m = Math.sqrt(x*x + y*y + z*z);

  if (m === 0) {
    m = 0.00001;
  }

  return [x/m, y/m, z/m];
}

function rotatePoint(x, y, angle) {
  return {
    x: Math.cos(angle)*x - Math.sin(angle)*y,
    y: Math.sin(angle)*x + Math.cos(angle)*y
  };
}


var Renderer = {

  start: function(options) {
    this.fogColor = options.fogColor ? Color.parse(options.fogColor).toRGBA(true) : FOG_COLOR;

    this.layers = {};
//this.layers.depth       = Depth.initShader();
    this.layers.skydome   = SkyDome.initShader();
    this.layers.basemap   = Basemap.initShader();
    this.layers.buildings = Buildings.initShader({
      showBackfaces: options.showBackfaces
    });

    this.resize();
    Events.on('resize', this.resize.bind(this));

    GL.cullFace(GL.BACK);
    GL.enable(GL.CULL_FACE);
    GL.enable(GL.DEPTH_TEST);

    //Events.on('contextlost', function() {
    //  this.stop();
    //}.bind(this));

    //Events.on('contextrestored', function() {
    //  this.start();
    //}.bind(this));

    this.loop = setInterval(function() {
      requestAnimationFrame(function() {
        Map.transform = new glx.Matrix()
          .rotateZ(Map.rotation)
          .rotateX(Map.tilt);

// console.log('CONTEXT LOST?', GL.isContextLost());

        // TODO: do matrix operations only on map change + store vpMatrix here
        var vpMatrix = new glx.Matrix(glx.Matrix.multiply(Map.transform, this.perspective));

//      this.layers.depth.render(vpMatrix);

        GL.clearColor(this.fogColor.r, this.fogColor.g, this.fogColor.b, 1);
        GL.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);

        this.layers.skydome.render(vpMatrix);
        this.layers.buildings.render(vpMatrix);
        this.layers.basemap.render(vpMatrix);
      }.bind(this));
    }.bind(this), 17);
  },

  stop: function() {
    clearInterval(this.loop);
  },

  resize: function() {
    var refHeight = 1024;
    var refVFOV = 45;

    this.perspective = new glx.Matrix()
      .translate(0, -HEIGHT/2, -1220) // 0, map y offset to neutralize camera y offset, map z -1220 scales map tiles to ~256px
      .scale(1, -1, 1) // flip Y
      .multiply(new glx.Matrix.Perspective(refVFOV * HEIGHT / refHeight, WIDTH/HEIGHT, 0.1, 5000))
      .translate(0, -1, 0); // camera y offset

    GL.viewport(0, 0, WIDTH, HEIGHT);
  },

  destroy: function() {
    this.stop();
    for (var k in this.layers) {
      this.layers[k].destroy();
    }
  }
};


var Depth = {};

(function() {

  var shader;

  Depth.initShader = function() {
    shader = new glx.Shader({
      vertexShader: SHADERS.depth.vertex,
      fragmentShader: SHADERS.depth.fragment,
      attributes: ["aPosition"],
      uniforms: ["uMatrix"]
    });

    return this;
  };

  Depth.render = function(vpMatrix) {
    if (Map.zoom < MIN_ZOOM) {
      return;
    }

    shader.enable();

    GL.clearColor(0, 0, 0, 1);
    GL.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);

    var item,
      mMatrix, mvp;

    var dataItems = data.Index.items;

    for (var i = 0, il = dataItems.length; i < il; i++) {
      item = dataItems[i];

      if (!(mMatrix = item.getMatrix())) {
        continue;
      }

      mvp = glx.Matrix.multiply(mMatrix, vpMatrix);
      GL.uniformMatrix4fv(shader.uniforms.uMatrix, false, mvp);

      item.vertexBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aPosition, item.vertexBuffer.itemSize, GL.FLOAT, false, 0, 0);

      GL.drawArrays(GL.TRIANGLES, 0, item.vertexBuffer.numItems);
    }

    shader.disable();
  };

}());


// TODO: perhaps render only clicked area

var Interaction = {

  idMapping: [null],
  viewportSize: 1024,

  initShader: function() {
    this.shader = new glx.Shader({
      vertexShader: SHADERS.interaction.vertex,
      fragmentShader: SHADERS.interaction.fragment,
      attributes: ["aPosition", "aColor"],
      uniforms: ["uMMatrix", "uMatrix", "uFogRadius"]
    });

    this.framebuffer = new glx.Framebuffer(this.viewportSize, this.viewportSize);
    return this;
  },

  // TODO: maybe throttle calls
  getTargetID: function(x, y, callback) {
    if (Map.zoom < MIN_ZOOM) {
      return;
    }

    var vpMatrix = new glx.Matrix(glx.Matrix.multiply(Map.transform, Renderer.perspective));

    var
      shader = this.shader,
      framebuffer = this.framebuffer;

    GL.viewport(0, 0, this.viewportSize, this.viewportSize);
    shader.enable();
    framebuffer.enable();

    GL.clearColor(0, 0, 0, 1);
    GL.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);

    GL.uniform1f(shader.uniforms.uFogRadius, SkyDome.radius);

    var
      dataItems = data.Index.items,
      item,
      mMatrix, mvp;

    for (var i = 0, il = dataItems.length; i < il; i++) {
      item = dataItems[i];

      if (!(mMatrix = item.getMatrix())) {
        continue;
      }

      GL.uniformMatrix4fv(shader.uniforms.uMMatrix, false, mMatrix.data);

      mvp = glx.Matrix.multiply(mMatrix, vpMatrix);
      GL.uniformMatrix4fv(shader.uniforms.uMatrix, false, mvp);

      item.vertexBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aPosition, item.vertexBuffer.itemSize, GL.FLOAT, false, 0, 0);

      item.idColorBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aColor, item.idColorBuffer.itemSize, GL.FLOAT, false, 0, 0);

      //item.visibilityBuffer.enable();
      //GL.vertexAttribPointer(shader.attributes.aHidden, item.visibilityBuffer.itemSize, GL.FLOAT, false, 0, 0);

      GL.drawArrays(GL.TRIANGLES, 0, item.vertexBuffer.numItems);
    }

    var imageData = framebuffer.getData();

    // DEBUG
    // // disable framebuffer
    // var imageData = new Uint8Array(WIDTH*HEIGHT*4);
    // GL.readPixels(0, 0, WIDTH, HEIGHT, GL.RGBA, GL.UNSIGNED_BYTE, imageData);

    shader.disable();
    framebuffer.disable();
    GL.viewport(0, 0, WIDTH, HEIGHT);

    //var index = ((HEIGHT-y/)*WIDTH + x) * 4;
    x = x/WIDTH*this.viewportSize <<0;
    y = y/HEIGHT*this.viewportSize <<0;
    var index = ((this.viewportSize-y)*this.viewportSize + x) * 4;
    var color = imageData[index] | (imageData[index + 1]<<8) | (imageData[index + 2]<<16);

    callback(this.idMapping[color]);
  },

  idToColor: function(id) {
    var index = this.idMapping.indexOf(id);
    if (index === -1) {
      this.idMapping.push(id);
      index = this.idMapping.length-1;
    }
//  return { r:255, g:128, b:0 }
    return {
      r:  index        & 0xff,
      g: (index >>  8) & 0xff,
      b: (index >> 16) & 0xff
    };
  }
};


var SkyDome = {};

(function() {

  var shader;

  var baseRadius = 500;

  var vertexBuffer;
  var texCoordBuffer;
  var texture;
  var textureIsLoaded;

  var latSegments = 8;
  var lonSegments = 24;

  function createDome(radius) {
    var
      res = { vertices: [], texCoords: [] },
      sin = Math.sin,
      cos = Math.cos,
      PI = Math.PI,
      azimuth1, x1, y1,
      azimuth2, x2, y2,
      polar1,
      polar2,
      A, B, C, D,
      tcLeft,
      tcRight,
      tcTop,
      tcBottom;

    for (var i = 0, j; i < lonSegments; i++) {
      tcLeft = i/lonSegments;
      azimuth1 = tcLeft*2*PI; // convert to radiants [0...2*PI]
      x1 = cos(azimuth1)*radius;
      y1 = sin(azimuth1)*radius;

      tcRight = (i+1)/lonSegments;
      azimuth2 = tcRight*2*PI;
      x2 = cos(azimuth2)*radius;
      y2 = sin(azimuth2)*radius;

      for (j = 0; j < latSegments; j++) {
        polar1 = j*PI/(latSegments*2); //convert to radiants in [0..1/2*PI]
        polar2 = (j+1)*PI/(latSegments*2);

        A = [x1*cos(polar1), y1*cos(polar1), radius*sin(polar1)];
        B = [x2*cos(polar1), y2*cos(polar1), radius*sin(polar1)];
        C = [x2*cos(polar2), y2*cos(polar2), radius*sin(polar2)];
        D = [x1*cos(polar2), y1*cos(polar2), radius*sin(polar2)];

        res.vertices.push.apply(res.vertices, A);
        res.vertices.push.apply(res.vertices, B);
        res.vertices.push.apply(res.vertices, C);
        res.vertices.push.apply(res.vertices, A);
        res.vertices.push.apply(res.vertices, C);
        res.vertices.push.apply(res.vertices, D);

        tcTop    = 1 - (j+1)/latSegments;
        tcBottom = 1 - j/latSegments;

        res.texCoords.push(tcLeft, tcBottom, tcRight, tcBottom, tcRight, tcTop, tcLeft, tcBottom, tcRight, tcTop, tcLeft, tcTop);
      }
    }

    return res;
  }

  SkyDome.initShader = function() {
    var url = 'skydome.jpg';

    var tris = createDome(baseRadius);

    this.resize();
    Events.on('resize', this.resize.bind(this));

    shader = new glx.Shader({
      vertexShader: SHADERS.skydome.vertex,
      fragmentShader: SHADERS.skydome.fragment,
      attributes: ["aPosition", "aTexCoord"],
      uniforms: ["uMatrix", "uTileImage", "uFogColor"]
    });

    vertexBuffer = new glx.Buffer(3, new Float32Array(tris.vertices));
    texCoordBuffer = new glx.Buffer(2, new Float32Array(tris.texCoords));
    Activity.setBusy();
    texture = new glx.texture.Image(url, function(image) {
      Activity.setIdle();
      if (image) {
        textureIsLoaded = true;
      }
    });

    return this;
  };

  SkyDome.resize = function() {
    this.radius = Math.sqrt(WIDTH*WIDTH + HEIGHT*HEIGHT) / 1; // 2 would fit fine but camera is too close
  };

  SkyDome.render = function(vpMatrix) {
    if (!textureIsLoaded) {
      return;
    }

    shader.enable();

    GL.uniform3fv(shader.uniforms.uFogColor, [Renderer.fogColor.r, Renderer.fogColor.g, Renderer.fogColor.b]);

    var mMatrix = new glx.Matrix();
    var scale = this.radius/baseRadius;
    mMatrix.scale(scale, scale, scale);

    var mvp = glx.Matrix.multiply(mMatrix, vpMatrix);
    GL.uniformMatrix4fv(shader.uniforms.uMatrix, false, mvp);

    vertexBuffer.enable();
    GL.vertexAttribPointer(shader.attributes.aPosition, vertexBuffer.itemSize, GL.FLOAT, false, 0, 0);

    texCoordBuffer.enable();
    GL.vertexAttribPointer(shader.attributes.aTexCoord, texCoordBuffer.itemSize, GL.FLOAT, false, 0, 0);

    texture.enable(0);
    GL.uniform1i(shader.uniforms.uTileImage, 0);

    GL.drawArrays(GL.TRIANGLES, 0, vertexBuffer.numItems);

    shader.disable();
  };

}());


var Basemap = {};

// TODO: try to use tiles from other zoom levels when some are missing

(function() {

  var shader;

  Basemap.initShader = function() {
    shader = new glx.Shader({
      vertexShader: SHADERS.basemap.vertex,
      fragmentShader: SHADERS.basemap.fragment,
      attributes: ["aPosition", "aTexCoord"],
      uniforms: ["uMMatrix", "uMatrix", "uTileImage", "uFogRadius", "uFogColor"]
    });

    return this;
  };

  Basemap.render = function(vpMatrix) {
    var
      tiles = TileGrid.getTiles(), item,
      mMatrix, mvp;

    shader.enable();

    GL.uniform1f(shader.uniforms.uFogRadius, SkyDome.radius);
    GL.uniform3fv(shader.uniforms.uFogColor, [Renderer.fogColor.r, Renderer.fogColor.g, Renderer.fogColor.b]);

    for (var key in tiles) {
      item = tiles[key];

      if (!(mMatrix = item.getMatrix())) {
        continue;
      }

      GL.uniformMatrix4fv(shader.uniforms.uMMatrix, false, mMatrix.data);

      mvp = glx.Matrix.multiply(mMatrix, vpMatrix);
      GL.uniformMatrix4fv(shader.uniforms.uMatrix, false, mvp);

      item.vertexBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aPosition, item.vertexBuffer.itemSize, GL.FLOAT, false, 0, 0);

      item.texCoordBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aTexCoord, item.texCoordBuffer.itemSize, GL.FLOAT, false, 0, 0);

      item.texture.enable(0);
      GL.uniform1i(shader.uniforms.uTileImage, 0);

      GL.drawArrays(GL.TRIANGLE_STRIP, 0, item.vertexBuffer.numItems);
    }

    shader.disable();
  };

}());


var Buildings = {};

(function() {

  var shader;

  Buildings.initShader = function(options) {
    shader = new glx.Shader({
      vertexShader: SHADERS.buildings.vertex,
      fragmentShader: SHADERS.buildings.fragment,
      attributes: ["aPosition", "aColor", "aNormal", "aIDColor"],
      uniforms: ["uMMatrix", "uMatrix", "uNormalTransform", "uAlpha", "uLightColor", "uLightDirection", "uFogRadius", "uFogColor", "uHighlightColor", "uHighlightID"]
    });

    this.showBackfaces = options.showBackfaces;
    return this;
  };

  Buildings.render = function(vpMatrix) {
    if (Map.zoom < MIN_ZOOM) {
      return;
    }

//  GL.enable(GL.BLEND);
//  GL.blendFunc(GL.SRC_ALPHA, GL.ONE);
//  GL.blendFunc(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
//  GL.disable(GL.DEPTH_TEST);

    shader.enable();

    if (this.showBackfaces) {
      GL.disable(GL.CULL_FACE);
    }

    // TODO: suncalc
    GL.uniform3fv(shader.uniforms.uLightColor, [0.5, 0.5, 0.5]);
    GL.uniform3fv(shader.uniforms.uLightDirection, unit(1, 1, 1));

    var normalMatrix = glx.Matrix.invert3(new glx.Matrix().data);
    GL.uniformMatrix3fv(shader.uniforms.uNormalTransform, false, glx.Matrix.transpose(normalMatrix));

    GL.uniform1f(shader.uniforms.uFogRadius, SkyDome.radius);
    GL.uniform3fv(shader.uniforms.uFogColor, [Renderer.fogColor.r, Renderer.fogColor.g, Renderer.fogColor.b]);

    if (!this.highlightColor) {
      this.highlightColor = DEFAULT_HIGHLIGHT_COLOR;
    }
    GL.uniform3fv(shader.uniforms.uHighlightColor, [this.highlightColor.r, this.highlightColor.g, this.highlightColor.b]);

    if (!this.highlightID) {
      this.highlightID = { r:0, g:0, b:0 };
    }
    GL.uniform3fv(shader.uniforms.uHighlightID, [this.highlightID.r/255, this.highlightID.g/255, this.highlightID.b/255]);

    var
      dataItems = data.Index.items,
      item,
      mMatrix, mvp;

    for (var i = 0, il = dataItems.length; i < il; i++) {
      item = dataItems[i];

      if (!(mMatrix = item.getMatrix())) {
        continue;
      }

      GL.uniformMatrix4fv(shader.uniforms.uMMatrix, false, mMatrix.data);

      mvp = glx.Matrix.multiply(mMatrix, vpMatrix);
      GL.uniformMatrix4fv(shader.uniforms.uMatrix, false, mvp);

      item.vertexBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aPosition, item.vertexBuffer.itemSize, GL.FLOAT, false, 0, 0);

      item.normalBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aNormal, item.normalBuffer.itemSize, GL.FLOAT, false, 0, 0);

      item.colorBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aColor, item.colorBuffer.itemSize, GL.FLOAT, false, 0, 0);

      item.idColorBuffer.enable();
      GL.vertexAttribPointer(shader.attributes.aIDColor, item.idColorBuffer.itemSize, GL.FLOAT, false, 0, 0);

//      item.visibilityBuffer.enable();
//      GL.vertexAttribPointer(shader.attributes.aHidden, item.visibilityBuffer.itemSize, GL.FLOAT, false, 0, 0);

      GL.drawArrays(GL.TRIANGLES, 0, item.vertexBuffer.numItems);
    }

    if (this.showBackfaces) {
      GL.enable(GL.CULL_FACE);
    }

    shader.disable();
  };

}());
}(this));