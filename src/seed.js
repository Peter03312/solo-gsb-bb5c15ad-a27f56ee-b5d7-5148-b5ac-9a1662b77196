'use strict';

/**
 * 首次启动写入的示例站场：
 *
 *   X1 S1 [ 1 ] SW7 [ 3 ] SW8 [ 5 ] S3 X3   正线(直股)
 *                      |             |
 *              X2 S2 [ 2 ]         [ 4 ] S4 X4  侧线(弯股)
 *
 *  进路 R1 正线通过   X1→X3 : 1,3,5      SW7=N SW8=N
 *  进路 R2 正线至侧线 X1→X4 : 1,3,4      SW7=N SW8=R
 *  进路 R3 侧线至正线 X2→X3 : 2,3,5      SW7=R SW8=N
 */
function seedDemo(db) {
  const already = db.prepare(`SELECT value FROM meta WHERE key='seeded_demo'`).get();
  if (already && already.value === '1') return false;

  const count = db.prepare(`SELECT COUNT(*) AS n FROM sections`).get().n;
  if (count > 0) {
    // 库里已有数据：仅打标记，不覆盖
    db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('seeded_demo','1')`).run();
    return false;
  }

  const tx = db.transaction(() => {
    const insSec = db.prepare(
      `INSERT INTO sections(id,label,x1,y1,x2,y2,occ_state)
       VALUES(@id,@label,@x1,@y1,@x2,@y2,@occ_state)`
    );
    // 示例区段初始为空闲，便于开箱即用
    const sections = [
      { id: '1', label: '1DG', x1: 90,  y1: 160, x2: 355, y2: 160, occ_state: 'free' },
      { id: '3', label: '3DG', x1: 445, y1: 160, x2: 575, y2: 160, occ_state: 'free' },
      { id: '5', label: '5DG', x1: 665, y1: 160, x2: 900, y2: 160, occ_state: 'free' },
      { id: '2', label: '2DG', x1: 150, y1: 320, x2: 392, y2: 320, occ_state: 'free' },
      { id: '4', label: '4DG', x1: 628, y1: 320, x2: 830, y2: 320, occ_state: 'free' }
    ];
    for (const s of sections) insSec.run(s);

    const insSw = db.prepare(
      `INSERT INTO switches(id,label,x,y,position,nx1,ny1,nx2,ny2,rx1,ry1,rx2,ry2)
       VALUES(@id,@label,@x,@y,'N',@nx1,@ny1,@nx2,@ny2,@rx1,@ry1,@rx2,@ry2)`
    );
    insSw.run({ id: 'SW7', label: '7#', x: 400, y: 160,
      nx1: 355, ny1: 160, nx2: 445, ny2: 160,
      rx1: 392, ry1: 172, rx2: 392, ry2: 308 });
    insSw.run({ id: 'SW8', label: '8#', x: 620, y: 160,
      nx1: 575, ny1: 160, nx2: 665, ny2: 160,
      rx1: 628, ry1: 172, rx2: 628, ry2: 308 });

    const insSig = db.prepare(
      `INSERT INTO signals(id,label,x,y,direction) VALUES(@id,@label,@x,@y,@direction)`
    );
    [
      { id: 'S1', label: 'S1/X1', x: 70,  y: 160, direction: 'right' },
      { id: 'S3', label: 'S3/X3', x: 930, y: 160, direction: 'left' },
      { id: 'S2', label: 'S2/X2', x: 130, y: 320, direction: 'right' },
      { id: 'S4', label: 'S4/X4', x: 850, y: 320, direction: 'left' }
    ].forEach((s) => insSig.run(s));

    const insRoute = db.prepare(
      `INSERT INTO routes(id,label,origin,destination,entry_signal_id)
       VALUES(@id,@label,@origin,@destination,@entry)`
    );
    const insStep = db.prepare(
      `INSERT INTO route_steps(route_id,step_order,section_id) VALUES(?,?,?)`
    );
    const insReq = db.prepare(
      `INSERT INTO route_switch_reqs(route_id,switch_id,req_position) VALUES(?,?,?)`
    );

    function addRoute(r) {
      insRoute.run({ id: r.id, label: r.label, origin: r.origin,
        destination: r.destination, entry: r.entry });
      r.steps.forEach((sid, i) => insStep.run(r.id, i + 1, sid));
      Object.entries(r.reqs).forEach(([sw, pos]) => insReq.run(r.id, sw, pos));
    }

    addRoute({ id: 'R1', label: '正线通过 X1→X3', origin: 'X1', destination: 'X3',
      entry: 'S1', steps: ['1', '3', '5'], reqs: { SW7: 'N', SW8: 'N' } });
    addRoute({ id: 'R2', label: '正线至侧线 X1→X4', origin: 'X1', destination: 'X4',
      entry: 'S1', steps: ['1', '3', '4'], reqs: { SW7: 'N', SW8: 'R' } });
    addRoute({ id: 'R3', label: '侧线至正线 X2→X3', origin: 'X2', destination: 'X3',
      entry: 'S2', steps: ['2', '3', '5'], reqs: { SW7: 'R', SW8: 'N' } });

    db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('seeded_demo','1')`).run();
  });

  tx();
  return true;
}

module.exports = { seedDemo };
