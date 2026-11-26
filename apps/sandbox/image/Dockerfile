# What an agent's code runs in. It is started fresh for every run, with no network, a
# read-only system and nothing of the server's: only the workspace's files, handed in and
# taken out as one stream. Everything a run may need has to be in here already.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils fonts-noto-cjk fonts-liberation fonts-dejavu-core \
      file zip unzip jq \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      numpy pandas scipy matplotlib seaborn scikit-learn statsmodels \
      openpyxl xlsxwriter xlrd python-docx python-pptx pypdf pymupdf pillow \
      lxml beautifulsoup4 tabulate pyyaml reportlab \
 && pip freeze > /opt/versions.txt

# Charts are drawn without a screen, and Chinese in them is drawn, not boxed.
RUN mkdir -p /etc/matplotlib && printf '%s\n' \
      'backend: Agg' \
      'font.sans-serif: Noto Sans CJK SC, DejaVu Sans, Liberation Sans' \
      'axes.unicode_minus: False' \
      'savefig.dpi: 144' \
      'savefig.bbox: tight' > /etc/matplotlib/matplotlibrc
ENV MATPLOTLIBRC=/etc/matplotlib/matplotlibrc

COPY entry.py /opt/entry.py
COPY look.py /usr/local/bin/look
RUN chmod 755 /usr/local/bin/look && useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin work

USER 1000:1000
WORKDIR /work
CMD ["python3", "/opt/entry.py"]
