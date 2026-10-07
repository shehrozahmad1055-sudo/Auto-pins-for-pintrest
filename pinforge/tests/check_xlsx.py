# Opens the .xlsx produced by the Node tests with openpyxl to prove Excel-compatible output.
import openpyxl, pathlib
p = pathlib.Path(__file__).parent / "out" / "test.xlsx"
ws = openpyxl.load_workbook(p).active
rows = list(ws.iter_rows(values_only=True))
assert rows[0][0] == "File name", rows[0]
assert rows[1][1] == "=SUM(A1)" or rows[1][1] == "'=SUM(A1)", rows[1][1]
assert rows[2][1] == "Üñíçødé <&>", rows[2][1]
assert "newline" in rows[1][2]
print("xlsx ok:", len(rows) - 1, "data rows")
